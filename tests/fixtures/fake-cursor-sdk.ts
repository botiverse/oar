/* oxlint-disable eslint/max-classes-per-file -- the agent and its run are one stand-in. */
import assert from "node:assert/strict";
import type { ControlOutcome, Session, SessionOptions } from "../../packages/oar/src/contracts/session.js";
import { cursorSessionWith } from "../../packages/oar/src/runtimes/cursor/session.js";
import type {
  CursorAgent,
  CursorAgentOptions,
  CursorDeltaListener,
  CursorRun,
  CursorSdk,
  ModelSelection,
  RunResult,
  SteerAckOutcome,
} from "../../packages/oar/src/runtimes/cursor/sdk.js";

/**
 * A stand-in for one `@cursor/sdk` 1.0.35 run, driven by the test: it ends
 * when the test (or `cancel`) ends it, and its steer answers with `ack`.
 */
export class FakeCursorRun implements CursorRun {
  readonly steered: string[] = [];
  cancelled = false;
  /** How the next steer is answered; `never` leaves it unanswered. */
  ack: SteerAckOutcome | "never" = "complete_delivered";
  private readonly done = Promise.withResolvers<RunResult>();

  constructor(readonly id: string, readonly message: unknown, readonly onDelta: CursorDeltaListener) {}

  async wait(): Promise<RunResult> {
    const result = await this.done.promise;
    return result;
  }

  /** `wait()` rejects instead of answering. */
  fail(error: Error): void {
    this.done.reject(error);
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.end("cancelled");
    await Promise.resolve();
  }

  async steer(text: string): Promise<SteerAckOutcome> {
    this.steered.push(text);
    if (this.ack === "never") {
      const unanswered = await Promise.withResolvers<SteerAckOutcome>().promise;
      return unanswered;
    }
    if (this.ack === "complete_delivered") {
      // The SDK echoes a delivered steer as an update (probed 2026-10-03).
      this.delta({ type: "user-message-appended", userMessage: { type: "user_message", session_id: "agent-1", text } });
    }
    await Promise.resolve();
    return this.ack;
  }

  delta(update: unknown): void {
    this.onDelta({ update });
  }

  end(status: RunResult["status"], extra: Partial<RunResult> = {}): void {
    this.done.resolve({ id: this.id, status, model: { id: "composer-2.5" }, ...extra });
  }
}

/** A stand-in for `@cursor/sdk` 1.0.35's local agent: each `send` returns a run the test ends. */
export class FakeCursorAgent implements CursorAgent {
  readonly runs: FakeCursorRun[] = [];
  /** Whether each `send` asked to take the agent over (`local.force`). */
  readonly forced: boolean[] = [];
  closed = false;
  /** Set to hold the next `send` until the test resolves it. */
  gate: Promise<void> | null = null;
  /** Set to make the next `send` throw. */
  refuse: Error | null = null;
  /** Set to end every new run as soon as it exists, with this status. */
  endAtOnce: RunResult["status"] | null = null;

  constructor(readonly agentId: string, readonly model: ModelSelection | undefined) {}

  // oxlint-disable-next-line eslint/max-statements -- each knob the tests turn, in the order the SDK would act.
  async send(message: unknown, options: { readonly onDelta: CursorDeltaListener; readonly local?: { readonly force: boolean } }): Promise<CursorRun> {
    this.forced.push(options.local?.force === true);
    if (this.gate !== null) {
      await this.gate;
    }
    const { refuse } = this;
    if (refuse !== null) {
      this.refuse = null;
      throw refuse;
    }
    const run = new FakeCursorRun(`run-${String(this.runs.length + 1)}`, message, options.onDelta);
    this.runs.push(run);
    if (this.endAtOnce !== null) {
      run.end(this.endAtOnce);
    }
    return run;
  }

  close(): void {
    this.closed = true;
  }

  latest(): FakeCursorRun {
    return this.runs.at(-1) ?? assert.fail("no run");
  }
}

export interface FakeCursorHarness {
  readonly session: Session;
  readonly agent: FakeCursorAgent;
  readonly opened: readonly { readonly how: "create" | "resume"; readonly id?: string; readonly options: CursorAgentOptions }[];
}

/** Open a cursor session over the stand-in SDK, in `/w`, with `options` (default model `composer`). */
export async function openFakeCursor(options?: Omit<SessionOptions, "cwd">): Promise<FakeCursorHarness> {
  const opened: FakeCursorHarness["opened"][number][] = [];
  const holder: { agent: FakeCursorAgent | null } = { agent: null };
  const sdk: CursorSdk = {
    Agent: {
      create: async (agentOptions) => {
        opened.push({ how: "create", options: agentOptions });
        holder.agent = new FakeCursorAgent("agent-1", agentOptions.model);
        await Promise.resolve();
        return holder.agent;
      },
      resume: async (id, agentOptions) => {
        opened.push({ how: "resume", id, options: agentOptions });
        holder.agent = new FakeCursorAgent(id, agentOptions.model);
        await Promise.resolve();
        return holder.agent;
      },
      listRuns: async () => {
        await Promise.resolve();
        return { items: [{ model: { id: "composer-2.5" }, createdAt: 1 }] };
      },
    },
    Cursor: {
      models: {
        list: async () => {
          await Promise.resolve();
          return [];
        },
      },
    },
  };
  const start = cursorSessionWith(async () => {
    await Promise.resolve();
    return sdk;
  });
  const session = await start({ kind: "available", via: "bundled" }, { cwd: "/w", ...(options ?? { model: "composer" }) });
  return { session, agent: holder.agent ?? assert.fail("no agent"), opened };
}

/** The rejection code of a control outcome, or null when it was accepted. */
export function codeOf(outcome: ControlOutcome): string | null {
  return outcome.kind === "rejected" ? outcome.code : null;
}

/** The rejection reason of a control outcome, or null when it was accepted. */
export function reasonOf(outcome: ControlOutcome): string | null {
  return outcome.kind === "rejected" ? outcome.reason : null;
}
