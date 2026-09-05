import { randomUUID } from "node:crypto";
import type { ContextUsage, Session, StartSession, Turn } from "../../contracts/session.js";
import { asRecord } from "../../shared/json.js";
import { sealSession } from "../../shared/seal-session.js";
import { createSessionKernel, type KernelTurn } from "../../shared/session-kernel.js";
import { classifyFailure } from "../../shared/failure-class.js";
import { startAppServerClient } from "./app-server-client.js";
import { codexContextUsageFromNotification } from "./context-usage.js";
import {
  codexPrompted,
  foldCodexNotification,
  initialCodexProjection,
  type CodexProjectionState,
} from "./projection.js";

/*
 * codex app-server v2 mapping:
 * - initialize → initialized, thread/start {cwd, ephemeral, approvalPolicy:never}
 * - turn/start {threadId, input} → {turn{id}}; completion via turn/completed
 *   notification whose turn.status is completed | interrupted | failed
 * - steer: turn/steer with the expectedTurnId precondition (race adjudicated
 *   at the runtime); typed rejection surfaces as not_steerable
 * - steer `accepted` here means: the runtime confirmed injection into the
 *   active turn (the strongest form; still expressed as the weak contract
 *   promise). Live probe: codex-session-adapter.ts.
 * - abort: turn/interrupt {threadId, turnId}
 */

interface CodexTurnState {
  readonly kernelTurn: KernelTurn;
  readonly codexTurnId: Promise<string>;
}

export const codexSession: StartSession = async (installation, options) => {
  if (installation.via !== "executable") {
    throw new Error("The codex session adapter needs an executable installation");
  }
  // YOLO default (repo policy 2026-08-24): bypass the sandbox too, not just
  // approvals — OAR_CODEX_SANDBOX pins a stricter mode when a host wants one.
  // Injected as a launch -c override because that is the only seam that
  // governs codex's exec tool; thread/start.sandboxMode does NOT (pinned on a
  // real login). A host that wants the user's own config to win can set
  // OAR_CODEX_SANDBOX=inherit to skip the override entirely.
  const sandboxMode = process.env.OAR_CODEX_SANDBOX ?? "danger-full-access";
  const configOverrides = sandboxMode === "inherit" ? {} : { sandbox_mode: `"${sandboxMode}"` };
  const client = startAppServerClient(installation.command, options.env, configOverrides);
  await client.request("initialize", {
    clientInfo: { name: "oar", version: "0.0.0" },
    capabilities: { experimentalApi: true },
  });
  client.notify("initialized", {});
  // Threads persist so a later SessionOptions.resume can reattach; the thread
  // id is the runtime-native identity and becomes Session.id.
  // System prompt seams (probed 2026-08-24 via the aimock journal):
  // baseInstructions REPLACES codex's base prompt; developerInstructions
  // APPENDS as a developer message. "instructions"/"userInstructions" are
  // silently ignored by thread/start.
  const instructionParams = {
    ...(options.systemPrompt === undefined ? {} : { baseInstructions: options.systemPrompt }),
    ...(options.appendSystemPrompt === undefined ? {} : { developerInstructions: options.appendSystemPrompt }),
  };
  const started = options.resume === undefined
    ? await client.request("thread/start", {
        cwd: options.cwd,
        ...(options.model === undefined ? {} : { model: options.model }),
        approvalPolicy: "never",
        // Required in addition to initialize.experimentalApi. This exposes
        // the completed Responses API reasoning item, whose encrypted_content
        // lets us distinguish redaction from genuinely empty reasoning.
        experimentalRawEvents: true,
        ...instructionParams,
      })
    : await client.request("thread/resume", {
        threadId: options.resume,
        cwd: options.cwd,
        // Same-runtime model switch = resume the same thread id with a new
        // model. thread/resume accepts `model` (codex rust-v0.153.4,
        // protocol/v2/thread.rs ThreadResumeParams) and applies it when the
        // thread is loaded cold, which is the normal case here because every
        // oar session owns its own app-server process.
        ...(options.model === undefined ? {} : { model: options.model }),
        approvalPolicy: "never",
        ...instructionParams,
      });
  const threadId = asRecord(started.thread)?.id;
  if (typeof threadId !== "string") {
    client.kill();
    throw new TypeError("codex thread start/resume returned no thread id");
  }
  // Both responses report the model that is actually active; that value is
  // what Session.model() reads back. Still check it against the request:
  // codex's resume_running_thread ignores resume overrides for a thread that
  // is already loaded and busy, logging only a warn ("thread/resume overrides
  // ignored for loaded thread"), and the response then names the old model.
  // A caller who asked for a model must not get a session silently running
  // another, so the mismatch fails loudly here and the app-server we just
  // started must not outlive the failed session.
  const effectiveModel = typeof started.model === "string" ? started.model : null;
  if (options.model !== undefined && effectiveModel !== null && effectiveModel !== options.model) {
    client.kill();
    const verb = options.resume === undefined ? "thread/start" : "thread/resume";
    throw new Error(`codex ${verb} kept model ${effectiveModel} although ${options.model} was requested`);
  }

  const kernel = createSessionKernel(threadId);
  let current: CodexTurnState | null = null;
  let disposed = false;
  let projection: CodexProjectionState = initialCodexProjection;
  let latestContextUsage: ContextUsage | null = null;

  // Drive the pure projection fold, applying its commands to the kernel; the
  // fold owns turn framing and event translation, this owns the transport-only
  // codexTurnId (steer/abort identity).
  client.onNotification((method, params) => {
    if (params.threadId !== threadId) {
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      latestContextUsage = codexContextUsageFromNotification(params) ?? latestContextUsage;
    }
    const { state: nextProjection, commands } = foldCodexNotification(projection, method, params);
    projection = nextProjection;
    for (const command of commands) {
      switch (command.kind) {
        case "begin": {
          // Spontaneous turn (a drained queue submission we did not prompt):
          // adopt it, taking the runtime turn id from the notification.
          const startedTurn = asRecord(params.turn)?.id;
          const kernelTurn = kernel.begin();
          if (kernelTurn !== null && typeof startedTurn === "string") {
            current = { kernelTurn, codexTurnId: Promise.resolve(startedTurn) };
          }
          break;
        }
        case "emit":
          current?.kernelTurn.emit(command.body);
          break;
        case "settle":
          current?.kernelTurn.settle(command.outcome);
          current = null;
          break;
        default:
          break;
      }
    }
  });
  client.onExit(() => {
    if (!disposed) {
      kernel.active()?.settle({ kind: "failed", reason: "codex app-server exited", failure: "runtime_exited" });
    }
  });

  const makeTurn = (state: CodexTurnState): Turn => ({
    id: state.kernelTurn.id,
    outcome: state.kernelTurn.outcome,
    abort: async () => {
      if (state.kernelTurn.settled()) {
        return;
      }
      const codexTurnId = await state.codexTurnId;
      if (!state.kernelTurn.settled()) {
        try {
          await client.request("turn/interrupt", { threadId, turnId: codexTurnId });
        } catch {
          // The turn ended before the interrupt landed — the contractual late
          // abort no-op; turn/completed settles the real outcome.
        }
        await state.kernelTurn.outcome;
      }
    },
    steer: async (input) => {
      if (state.kernelTurn.settled()) {
        return { kind: "not_steerable", reason: "turn already ended" };
      }
      const codexTurnId = await state.codexTurnId;
      try {
        await client.request("turn/steer", {
          threadId,
          input: [{ type: "text", text: input }],
          expectedTurnId: codexTurnId,
        });
        return { kind: "accepted" };
      } catch (error) {
        return { kind: "not_steerable", reason: error instanceof Error ? error.message : "rejected" };
      }
    },
  });

  const session: Session = sealSession({
    id: kernel.sessionId,
    prompt(input) {
      const kernelTurn = kernel.begin();
      if (kernelTurn === null) {
        return { kind: "busy" };
      }
      const codexTurnId = (async (): Promise<string> => {
        const response = await client.request("turn/start", {
          threadId,
          input: [{ type: "text", text: input }],
        });
        const turnId = asRecord(response.turn)?.id;
        if (typeof turnId !== "string") {
          throw new TypeError("codex turn/start returned no turn id");
        }
        return turnId;
      })();
      void (async (): Promise<void> => {
        try {
          await codexTurnId;
        } catch (error) {
          const reason = error instanceof Error ? error.message : "turn/start failed";
          kernelTurn.settle({ kind: "failed", reason, failure: classifyFailure(reason) });
        }
      })();
      const state: CodexTurnState = { kernelTurn, codexTurnId };
      current = state;
      projection = codexPrompted(projection);
      return { kind: "turn", turn: makeTurn(state) };
    },
    subscribe: (observer) => kernel.subscribe(observer),
    model: () => effectiveModel,
    contextUsage: () => latestContextUsage,
    queue: {
      durable: true,
      add: async (input) => {
        await client.request("thread/queue/add", {
          threadId,
          input: [{ type: "text", text: input }],
          clientUserMessageId: randomUUID(),
        });
      },
    },
    dispose: async () => {
      if (disposed) {
        return;
      }
      disposed = true;
      kernel.active()?.settle({ kind: "aborted" });
      client.kill();
      // Await the actual exit: the process may hold state (codex's sqlite
      // runtime in CODEX_HOME) that the next session needs released.
      await client.exited;
    },
  });
  return session;
};
