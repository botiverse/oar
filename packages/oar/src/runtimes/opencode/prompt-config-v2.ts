import { UnsupportedOptionError } from "../../contracts/errors.js";
import type { SessionOptions } from "../../contracts/session.js";
import { sessionEnvironment } from "../../shared/environment.js";
import { processFailure } from "../../shared/executable/diagnostics.js";
import { runExecutable, type ExecutableRunner } from "../../shared/executable/run.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import { configContent, instructionsFile, openedAgent, validateOpenCodePrompts, type OpenCodePromptConfig } from "./prompt-config.js";
import { acquireOpenCodeStartup } from "./startup-gate.js";
import type { OpencodeRelease } from "./version.js";

/** The private server opens the native database like an ACP start does, so it waits its turn behind the same gate. */
async function gated<T>(options: SessionOptions, work: () => Promise<T>): Promise<T> {
  const release = await acquireOpenCodeStartup(options);
  try { return await work(); } finally { release(); }
}

/** First v2 releases measured to apply each part of the overlay (experiments/opencode-v2-prompts). */
const V2_INSTRUCTIONS = { minor: 0, patch: 30, version: "2.0.30" } as const;
const V2_AGENT_LISTING = { minor: 2, patch: 0, version: "2.2.0" } as const;

/** A pre-release of the floor itself (`2.2.0-beta`) is below it: it may predate the measured behavior. */
function atLeast(release: OpencodeRelease, floor: { readonly minor: number; readonly patch: number }): boolean {
  if (release.minor !== floor.minor) { return release.minor > floor.minor; }
  if (release.patch !== floor.patch) { return release.patch > floor.patch; }
  return !/^\d+\.\d+\.\d+-/u.test(release.version);
}

/**
 * The agents a v2 session can open on: primary or all-mode agents that are not
 * hidden, from `debug agents` on a private server with the session's own
 * environment and directory. Subagents and hidden agents (compaction, title)
 * keep their native prompts.
 */
async function primaryAgents(command: string, options: SessionOptions, run: ExecutableRunner): Promise<readonly string[]> {
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
    entry !== null && typeof entry.id === "string" && entry.mode !== "subagent" && entry.hidden !== true ? [entry.id] : []);
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
  if (options.appendSystemPrompt !== undefined && !atLeast(release, V2_INSTRUCTIONS)) {
    throw new UnsupportedOptionError("appendSystemPrompt", `opencode ${release.version} does not load configured instructions; ${V2_INSTRUCTIONS.version} or later does`);
  }
  if (options.systemPrompt !== undefined && !atLeast(release, V2_AGENT_LISTING)) {
    throw new UnsupportedOptionError("systemPrompt", `opencode ${release.version} cannot list its agents without the shared background service; ${V2_AGENT_LISTING.version} or later can`);
  }
  const agents = options.systemPrompt === undefined ? undefined : await primaryAgents(command, options, run);
  const instructions = await instructionsFile(options.appendSystemPrompt);
  const overlay = {
    ...(agents === undefined ? {} : { agents: Object.fromEntries(agents.map((agent) => [agent, { system: options.systemPrompt }])) }),
    ...(instructions.path === undefined ? {} : { instructions: [instructions.path] }),
  };
  return { options: { ...options, env: { ...options.env, OPENCODE_CONFIG_CONTENT: configContent(overlay) } }, ...(agents === undefined ? {} : { agents }), cleanup: instructions.cleanup };
}

export function verifyOpenCodeAgents(response: JsonRecord, expected: readonly string[]): void {
  const actual = openedAgent(response);
  if (typeof actual !== "string" || !expected.includes(actual)) {
    throw new Error(`opencode opened on agent ${actual === undefined ? "<unreported>" : JSON.stringify(actual)}, but the system prompt was configured for ${expected.map((agent) => JSON.stringify(agent)).join(", ")}`);
  }
}
