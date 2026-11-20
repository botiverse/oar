import { lstatSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { UnsupportedOptionError, type Runtime, type Session, type SessionOptions } from "../../packages/oar/src/index.js";
import type { RecyclePolicy } from "./budget.js";
import type { AgentState, Message } from "./store.js";

export interface AgentOptions {
  /** A running turn with no new record for this long is reported `stalled`. */
  readonly stallMs: number;
  /** Absolute path of this agent's own `harbor` executable (its name is baked in). */
  readonly bin: string;
  /** Start a fresh session with a handoff instead of resuming one that sat idle with a large context; null never does. */
  readonly recycle: RecyclePolicy | null;
  /** Hold deliveries once an agent's sessions reported this many tokens in a UTC day; null sets no cap. */
  readonly dayTokens: number | null;
}

export interface AgentStatusLine {
  readonly name: string;
  readonly runtime: string;
  readonly model: string | null;
  readonly state: "starting" | "idle" | "running" | "down";
  /** Running: since the turn started; otherwise null. */
  readonly forMs: number | null;
  readonly turns: number;
  readonly lastOutcome: string | null;
  readonly contextPercent: number | null;
  readonly contextTokens: number | null;
  readonly tokens: { readonly input: number; readonly output: number } | null;
  readonly pending: number;
  readonly awaitingReply: boolean;
  readonly sessionId: string | null;
  readonly opens: number;
}

export function formatMessage(message: Message): string {
  return `[harbor msg=${message.seq} time=${new Date(message.at).toISOString()} from=@${message.from}] ${message.text}`;
}

export function preamble(name: string, cwd: string, bin: string): string {
  return [
    `You are @${name}, an agent working in harbor: a shared channel where people and other agents send you work.`,
    "Messages reach you as lines starting with `[harbor msg=... from=@...]`. Nobody sees your ordinary output:",
    `to answer, ask a question or report a result, run ${bin} send with the text on stdin, e.g.`,
    `  ${bin} send <<'EOF'`,
    "  @qa done: ...",
    "  EOF",
    `\`${bin} read\` shows recent channel messages. Everyone, people included, reads everything you post;`,
    "@name only decides which agents are woken. Acknowledge work you take on,",
    `then report when it is done. Your working directory is ${cwd}.`,
    "Other chat tools on this machine (such as `raft`) belong to the person hosting you and act as them: do not run them.",
  ].join("\n");
}

/**
 * For a runtime without an appended system prompt, repeated on every later delivery: compaction can drop the preamble
 * (OpenCode 1.x does not even report its compactions), and an agent that forgot how to answer goes looking for another chat tool.
 */
export function reminder(bin: string): string {
  return `(harbor: answer only with ${bin} send; other chat tools here, such as \`raft\`, act as the person hosting you)`;
}

/**
 * Opens with the channel rules in the appended system prompt, as a Raft host puts its own, so compaction cannot summarize
 * them away; given on every open, because a resume that omits it keeps the saved value only until compaction. A runtime
 * that declares or answers a refusal opens without it (`rulesInPrompt: false`, the refusal kept for the journal), and the
 * rules then travel in messages.
 */
export async function openWithRules(runtime: Runtime, installation: Parameters<Runtime["session"]>[0], base: SessionOptions, rules: string): Promise<{ session: Session; rulesInPrompt: boolean; refusal?: string }> {
  const declared = runtime.refusedSessionOptions?.appendSystemPrompt;
  if (declared !== undefined) {
    return { session: await runtime.session(installation, base), rulesInPrompt: false, refusal: declared };
  }
  try {
    return { session: await runtime.session(installation, { ...base, appendSystemPrompt: rules }), rulesInPrompt: true };
  } catch (error) {
    if (!(error instanceof UnsupportedOptionError) || error.option !== "appendSystemPrompt") {
      throw error;
    }
    return { session: await runtime.session(installation, base), rulesInPrompt: false, refusal: error.message };
  }
}

/** Linux: processes whose cwd is inside `dir`; elsewhere the check is skipped. */
export function processesIn(dir: string): number[] {
  if (process.platform !== "linux") {
    return [];
  }
  const pids: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/u.test(entry) || Number(entry) === process.pid) {
      continue;
    }
    try {
      const cwd = readlinkSync(`/proc/${entry}/cwd`);
      if (cwd === dir || cwd.startsWith(`${dir}/`)) {
        pids.push(Number(entry));
      }
    } catch {
      // gone, or not ours to read
    }
  }
  return pids;
}

/** Runs steps one at a time, each after the previous one settled (whether it threw or not). */
export class Serial {
  private last: Promise<void> = Promise.resolve();

  async run(step: () => Promise<void>): Promise<void> {
    const previous = this.last;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.last = promise;
    try {
      await previous;
      await step();
    } finally {
      resolve();
    }
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface StatusInput {
  readonly session: Session | null;
  readonly state: AgentState;
  readonly starting: boolean;
  readonly turnStartedAt: number | null;
  readonly turns: number;
  readonly lastOutcome: string | null;
  readonly pending: number;
  readonly awaitingReply: boolean;
}

export function statusLine(input: StatusInput, now: number): AgentStatusLine {
  const { session } = input;
  const status = session?.status().value;
  const context = session?.contextUsage().value ?? null;
  let state: AgentStatusLine["state"] = "down";
  let forMs: number | null = null;
  if (input.starting) {
    state = "starting";
  } else if (status?.kind === "running") {
    state = "running";
    forMs = input.turnStartedAt === null ? null : now - input.turnStartedAt;
  } else if (status?.kind === "idle") {
    state = "idle";
  }
  return {
    name: input.state.name,
    runtime: input.state.runtime,
    model: session?.model().value ?? input.state.model ?? null,
    state,
    forMs,
    turns: input.turns,
    lastOutcome: input.lastOutcome,
    contextPercent: context?.percent ?? null,
    contextTokens: context?.tokens ?? null,
    tokens: session?.usage().value.total ?? null,
    pending: input.pending,
    awaitingReply: input.awaitingReply,
    sessionId: input.state.sessionId ?? null,
    opens: input.state.opens,
  };
}

/** Bytes under `dir`, not following symlinks; unreadable entries count as zero. */
export function directoryBytes(dir: string): number {
  let total = 0;
  const stack = [dir];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    let entries: string[] = [];
    try {
      entries = readdirSync(next);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = join(next, entry);
      try {
        const stat = lstatSync(file);
        if (stat.isDirectory()) {
          stack.push(file);
        } else {
          total += stat.size;
        }
      } catch {
        // gone while counting
      }
    }
  }
  return total;
}
