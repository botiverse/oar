/* oxlint-disable typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion -- Every file read here is one harbor itself wrote with these shapes. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { DayTokens } from "./budget.js";

/**
 * A harbor run lives in one directory, and every file in it is append-only
 * JSONL or a small JSON snapshot, so a QA agent can read the evidence with
 * ordinary tools while the daemon runs:
 *
 *   channel.jsonl              every message, in order (the conversation)
 *   journal.jsonl              what harbor did and saw: deliveries, turns, exits, findings
 *   agents/<name>/session-<n>.voyage.jsonl   OAR's own voyage log per session open:
 *                              each native record verbatim plus OAR's events
 *   agents/<name>/work/        the agent's working directory
 *   state.json                 agent specs and session ids, for `up` to resume
 *   daemon.json                the live daemon's pid and loopback port
 */

export interface Message {
  readonly seq: number;
  readonly at: number;
  readonly from: string;
  readonly text: string;
  /** Agents this message is delivered to. */
  readonly to: readonly string[];
}

export type JournalEntry = { readonly at: number; readonly agent?: string; readonly kind: string } & Record<string, unknown>;

export interface AgentSpec {
  readonly name: string;
  readonly runtime: string;
  readonly model?: string;
  readonly effort?: string;
  readonly cwd?: string;
  /**
   * Environment for this agent only: passed to its installation probe and its
   * sessions (e.g. `OAR_OPENCODE_BIN` to pick one of two installs, XDG
   * directories to keep its data apart). Absent means none is passed, which
   * every runtime accepts; cursor's in-process mode refuses a session `env`.
   */
  readonly env?: Readonly<Record<string, string>>;
}

export interface AgentState extends AgentSpec {
  readonly sessionId?: string;
  readonly opens: number;
  /** Tokens this agent's sessions reported in the current UTC day, for `--day-tokens`. */
  readonly dayTokens?: DayTokens;
  /** The context size the session last reported, so a session resumed after a harbor restart can be recycled before it reports again. */
  readonly contextTokens?: number;
}

export interface RunState {
  readonly agents: readonly AgentState[];
}

export interface DaemonInfo {
  readonly pid: number;
  readonly port: number;
  readonly startedAt: number;
}

/** Outside any repository, so agents do not pick up a checkout's instructions or git state by accident. */
export const DEFAULT_RUN = join(homedir(), ".oar-harbor", "default");

export function runDir(explicit?: string): string {
  return resolve(explicit ?? process.env.HARBOR_DIR ?? DEFAULT_RUN);
}

export class Store {
  readonly dir: string;
  private seq: number;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(join(dir, "agents"), { recursive: true });
    this.seq = this.messages().at(-1)?.seq ?? 0;
  }

  agentDir(name: string): string {
    const dir = join(this.dir, "agents", name);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  post(from: string, text: string, to: readonly string[]): Message {
    this.seq += 1;
    const message: Message = { seq: this.seq, at: Date.now(), from, text, to };
    appendFileSync(join(this.dir, "channel.jsonl"), `${JSON.stringify(message)}\n`);
    return message;
  }

  messages(): Message[] {
    return readJsonl<Message>(join(this.dir, "channel.jsonl"));
  }

  journal(entry: Omit<JournalEntry, "at">): void {
    appendFileSync(join(this.dir, "journal.jsonl"), `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
  }

  entries(): JournalEntry[] {
    return readJsonl<JournalEntry>(join(this.dir, "journal.jsonl"));
  }

  state(): RunState | null {
    const file = join(this.dir, "state.json");
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as RunState) : null;
  }

  saveState(state: RunState): void {
    writeFileSync(join(this.dir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
  }
}

export function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) {
    return [];
  }
  const out: T[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // A line being written right now; the next read sees it whole.
    }
  }
  return out;
}

export function daemonInfo(dir: string): DaemonInfo | null {
  const file = join(dir, "daemon.json");
  if (!existsSync(file)) {
    return null;
  }
  const info = JSON.parse(readFileSync(file, "utf8")) as DaemonInfo;
  try {
    process.kill(info.pid, 0);
    return info;
  } catch {
    return null;
  }
}

/** `alice=codex:gpt-5.5`, `claude`, `agy:hydrogen` (name defaults to the runtime id). */
export function parseAgentSpec(spec: string): AgentSpec {
  const eq = spec.indexOf("=");
  const name = eq === -1 ? undefined : spec.slice(0, eq);
  const [runtime = "", ...rest] = (eq === -1 ? spec : spec.slice(eq + 1)).split(":");
  const model = rest.join(":");
  const agentName = name ?? runtime;
  if (!/^[\w-]+$/u.test(agentName) || runtime === "") {
    throw new Error(`bad agent spec ${JSON.stringify(spec)}: use name=runtime[:model]`);
  }
  return { name: agentName, runtime, ...(model === "" ? {} : { model }) };
}

/** `name:KEY=VALUE` from `--agent-env`, applied to the agent of that name. */
export function parseAgentEnv(entries: readonly string[]): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  for (const entry of entries) {
    const match = /^([\w-]+):([A-Za-z_][\w]*)=(.*)$/u.exec(entry);
    if (match === null) {
      throw new Error(`bad --agent-env ${JSON.stringify(entry)}: use name:KEY=VALUE`);
    }
    const [, name = "", key = "", value = ""] = match;
    out.set(name, { ...out.get(name), [key]: value });
  }
  return out;
}

/** `@name` tokens in a message; `@all` addresses every agent. */
export function mentionsIn(text: string): string[] {
  return [...text.matchAll(/(?<![\w@])@([\w-]+)/gu)].map((match) => match[1] ?? "");
}
