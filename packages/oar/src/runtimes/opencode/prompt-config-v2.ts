import { UnsupportedOptionError } from "../../contracts/errors.js";
import type { SessionOptions } from "../../contracts/session.js";
import { sessionEnvironment } from "../../shared/environment.js";
import { processFailure } from "../../shared/executable/diagnostics.js";
import { runExecutable, type ExecutableRunner } from "../../shared/executable/run.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import { preparePromptOptions, openedAgent, validateOpenCodePrompts, type OpenCodePromptConfig } from "./prompt-config.js";
import { opencodeV2PromptRefusals } from "./options.js";
import { acquireOpenCodeStartup } from "./startup-gate.js";
import type { OpencodeRelease } from "./version.js";

/** The private server opens the native database like an ACP start does, so it waits its turn behind the same gate. */
async function gated<T>(options: SessionOptions, work: () => Promise<T>): Promise<T> {
  const release = await acquireOpenCodeStartup(options);
  try { return await work(); } finally { release(); }
}

/**
 * The agents a v2 session can open on: primary or all-mode agents that are not
 * hidden, from `debug agents` on a private server with the session's own
 * environment and directory. Subagents and hidden agents (compaction, title)
 * keep their native prompts.
 */
async function primaryAgents(command: string, options: SessionOptions, run: ExecutableRunner): Promise<readonly { id: string; system: unknown }[]> {
  // oxlint-disable-next-line typescript/promise-function-async -- the runner already returns its promise.
  const result = await gated(options, () => run(command, ["debug", "agents", "--standalone"], { cwd: options.cwd, env: sessionEnvironment(options.env), timeoutMs: 30_000 }));
  if (!result.ok) {
    throw processFailure("opencode debug agents failed while resolving the session's agents", result.diagnostics ?? { exitCode: result.exitCode, signal: null, stderr: result.stderr });
  }
  let listed: unknown = undefined;
  try { listed = JSON.parse(result.stdout); } catch { /* reported below */ }
  if (!Array.isArray(listed)) {
    throw new TypeError("opencode debug agents returned no agent list while resolving the session's agents");
  }
  const agents = listed.map((entry) => asRecord(entry)).flatMap((entry) =>
    entry !== null && typeof entry.id === "string" && entry.mode !== "subagent" && entry.hidden !== true ? [{ id: entry.id, system: entry.system }] : []);
  if (agents.length === 0) {
    throw new UnsupportedOptionError("systemPrompt", "opencode reports no visible primary agent whose system prompt could be replaced");
  }
  return agents;
}

/**
 * v2: `systemPrompt` sets `agents.<id>.system` on every visible primary agent
 * that already exists, so it holds whichever of them the session opens on or
 * switches to, a new session and a resume alike. `appendSystemPrompt` is one
 * session-owned file in `instructions`. Nothing is created or written to the
 * user's configuration.
 */
export async function prepareOpenCodeV2Prompts(command: string, release: OpencodeRelease, options: SessionOptions, run: ExecutableRunner = runExecutable): Promise<OpenCodePromptConfig> {
  validateOpenCodePrompts(options);
  const refused = opencodeV2PromptRefusals(release);
  for (const option of ["appendSystemPrompt", "systemPrompt"] as const) {
    const reason = refused[option];
    if (options[option] !== undefined && reason !== undefined) { throw new UnsupportedOptionError(option, reason); }
  }
  const primary = options.systemPrompt === undefined ? undefined : await primaryAgents(command, options, run);
  const agents = primary?.map(entry => entry.id);
  const prepared = await preparePromptOptions(options, "agents", agents ?? [], async (merged) => {
    const confirmed = await primaryAgents(command, merged, run);
    for (const id of agents ?? []) {
      if (confirmed.find(entry => entry.id === id)?.system !== options.systemPrompt) {
        throw new UnsupportedOptionError("systemPrompt", `opencode debug agents did not confirm agents.${id}.system`);
      }
    }
  });
  return { ...prepared, ...(agents === undefined ? {} : { agents }) };
}

export function verifyOpenCodeAgents(response: JsonRecord, expected: readonly string[]): void {
  const actual = openedAgent(response);
  if (typeof actual !== "string" || !expected.includes(actual)) {
    throw new Error(`opencode opened on agent ${actual === undefined ? "<unreported>" : JSON.stringify(actual)}, but the system prompt was configured for ${expected.map((agent) => JSON.stringify(agent)).join(", ")}`);
  }
}
