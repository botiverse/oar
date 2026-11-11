import { asRecord, asRecordList } from "../../../shared/json.js";
import type {
  CursorAgent,
  CursorAuth,
  CursorAuthStatus,
  CursorDeltaListener,
  CursorLoginOptions,
  CursorRun,
  CursorSdk,
  ModelListItem,
  ModelSelection,
  SteerAckOutcome,
} from "../sdk.js";
import type { CursorChannel } from "./channel.js";

/*
 * `CursorSdk` over a cursor child (channel.ts): each SDK object the child
 * holds (an agent, a run) is named by the id of the call that made it, and
 * every method is a call. Replies are checked for the shape the adapter
 * reads; nothing here holds a credential.
 */

type ListRunsPage = Awaited<ReturnType<CursorSdk["Agent"]["listRuns"]>>;

function isModelSelection(value: unknown): value is ModelSelection {
  return typeof asRecord(value)?.id === "string";
}

function isModelList(value: unknown): value is readonly ModelListItem[] {
  return Array.isArray(value) && asRecordList(value).length === value.length
    && asRecordList(value).every((model) => typeof model.id === "string" && typeof model.displayName === "string");
}

function isListRunsPage(value: unknown): value is ListRunsPage {
  const page = asRecord(value);
  return page !== null && Array.isArray(page.items) && (page.nextCursor === undefined || typeof page.nextCursor === "string");
}

function isAuthStatus(value: unknown): value is CursorAuthStatus {
  const status = asRecord(value)?.status;
  return status === "logged-in" || status === "logged-out";
}

function isSteerAck(value: unknown): value is SteerAckOutcome {
  return value === "complete_delivered" || value === "revert_to_followup";
}

function unexpected(call: string): Error {
  return new Error(`cursor's child process answered ${call} with a shape oar cannot read`);
}

/** The run a `send` or `summarize` call made, as the child described it. */
function proxyRun(channel: CursorChannel, key: number, value: unknown): CursorRun {
  const described = asRecord(value);
  if (typeof described?.runId !== "string") { throw unexpected("a send"); }
  const runId = described.runId;
  const run: CursorRun = {
    id: runId,
    stream: () => proxyStream(channel, key),
    wait: async () => { const result = await channel.call("wait", [key]); return result; },
    cancel: async () => { await channel.call("cancel", [key]); },
  };
  if (described.steer !== true) { return run; }
  return {
    ...run,
    async steer(text) {
      const ack = await channel.call("steer", [key, text]);
      if (!isSteerAck(ack)) { throw unexpected("a steer"); }
      return ack;
    },
  };
}

/** The run's `stream()`: the child reads it and forwards each message; `return()` stops the child's reading. */
function proxyStream(channel: CursorChannel, key: number): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]: (): AsyncIterator<unknown> => {
      const queue: unknown[] = [];
      let wake = Promise.withResolvers<void>();
      const state: { ended: boolean; error: Error | null } = { ended: false, error: null };
      const streaming = channel.start("stream", [key], (message) => { queue.push(message); wake.resolve(); });
      void (async (): Promise<void> => {
        try {
          await streaming.reply;
        } catch (error) {
          state.error = error instanceof Error ? error : new Error(String(error));
        } finally {
          state.ended = true;
          wake.resolve();
        }
      })();
      return {
        async next(): Promise<IteratorResult<unknown>> {
          for (;;) {
            if (queue.length > 0) { return { done: false, value: queue.shift() }; }
            if (state.ended) {
              if (state.error !== null) { throw state.error; }
              return { done: true, value: undefined };
            }
            await wake.promise;
            wake = Promise.withResolvers<void>();
          }
        },
        async return(): Promise<IteratorResult<unknown>> {
          queue.length = 0;
          // Not waiting for the child's reading to end: an SDK stream can queue return() behind its pending next() (run.ts).
          if (!state.ended) {
            try { await channel.call("unstream", [streaming.id]); } catch { /* The child may be gone; nothing more arrives then. */ }
          }
          return { done: true, value: undefined };
        },
      };
    },
  };
}

async function proxyAgent(channel: CursorChannel, opening: { readonly id: number; readonly reply: Promise<unknown> }): Promise<CursorAgent> {
  const key = opening.id;
  const value = await opening.reply;
  const described = asRecord(value);
  if (typeof described?.agentId !== "string") { throw unexpected("an open"); }
  const model = isModelSelection(described.model) ? described.model : undefined;
  const launch = async (method: "send" | "summarize", args: readonly unknown[], onDelta?: CursorDeltaListener): Promise<CursorRun> => {
    const started = channel.start(method, [key, ...args], onDelta === undefined ? undefined : (update): void => { onDelta({ update }); });
    return proxyRun(channel, started.id, await started.reply);
  };
  const agent: CursorAgent = {
    agentId: described.agentId,
    model,
    send: async (message, options) => {
      const run = await launch("send", [message, options.local], options.onDelta);
      return run;
    },
    close() {
      void (async (): Promise<void> => {
        try { await channel.call("close", [key]); } catch { /* The child ending closes the agent with it. */ }
      })();
    },
  };
  if (described.summarize !== true) { return agent; }
  return { ...agent, summarize: async () => { const run = await launch("summarize", []); return run; } };
}

/** `Cursor.auth` over the child: the login's save is decided here, and done there. */
function proxyAuth(channel: CursorChannel): CursorAuth {
  const auth: CursorAuth = {
    async login(options: CursorLoginOptions) {
      const stop = (): void => {
        void (async (): Promise<void> => {
          try { await channel.call("abortLogin", []); } catch { /* The child may be gone. */ }
        })();
      };
      options.signal.addEventListener("abort", stop, { once: true });
      try {
        await channel.call("login", [], (event) => {
          const step = asRecord(event);
          if (typeof step?.url === "string") { options.onLoginUrl(step.url); }
          if (step?.save === true) { void decideSave(channel, options); }
        });
      } finally {
        options.signal.removeEventListener("abort", stop);
      }
    },
    async status() {
      const status = await channel.call("status", []);
      if (!isAuthStatus(status)) { throw unexpected("Cursor.auth.status"); }
      return status;
    },
  };
  if (!channel.features.logout) { return auth; }
  return { ...auth, logout: async () => { await channel.call("logout", []); } };
}

/**
 * The SDK in the child asked to save its key. The host's login store decides
 * (login.ts): it refuses once OAR ended the login, or passes the save on to
 * `FileCredentialStore.save`, which here tells the child to save to its own
 * store (`commit`). The child is then told how it went.
 */
async function decideSave(channel: CursorChannel, options: CursorLoginOptions): Promise<void> {
  try {
    // A placeholder: the credentials stay in the child.
    await options.store.save({});
    await channel.call("saved", []);
  } catch (error) {
    try { await channel.call("refused", [error instanceof Error ? error.message : String(error)]); } catch { /* The child is gone. */ }
  }
}

/**
 * `CursorSdk` over one cursor child. `apiKey` is the `CURSOR_API_KEY` the
 * lease took out of the child's environment: it goes to the SDK as
 * `AgentOptions.apiKey` (create, resume) and `CursorRequestOptions.apiKey`
 * (`Cursor.models.list`), which SDK 1.3.1 uses instead of the variable.
 * Local `Agent.listRuns` reads the local store and takes none.
 */
export function proxySdk(channel: CursorChannel, apiKey?: string): CursorSdk {
  const keyed = (options: object): object => (apiKey === undefined ? options : { ...options, apiKey });
  const open = async (method: "create" | "resume", args: readonly unknown[]): Promise<CursorAgent> => {
    const agent = await proxyAgent(channel, channel.start(method, args));
    return agent;
  };
  const { features } = channel;
  return {
    Agent: {
      create: async (options) => { const agent = await open("create", [keyed(options)]); return agent; },
      resume: async (agentId, options) => { const agent = await open("resume", [agentId, keyed(options)]); return agent; },
      async listRuns(agentId, options) {
        const page = await channel.call("listRuns", [agentId, options]);
        if (!isListRunsPage(page)) { throw unexpected("Agent.listRuns"); }
        return page;
      },
    },
    Cursor: {
      models: {
        async list() {
          const models = await channel.call("models", apiKey === undefined ? [] : [{ apiKey }]);
          if (!isModelList(models)) { throw unexpected("Cursor.models.list"); }
          return models;
        },
      },
      ...(features.auth ? { auth: proxyAuth(channel) } : {}),
    },
    ...(features.store ? {
      FileCredentialStore: class {
        // The argument is the login store's placeholder; the child saves what its SDK gave it.
        async save(): Promise<void> {
          await channel.call("commit", []);
        }
      },
    } : {}),
  };
}
