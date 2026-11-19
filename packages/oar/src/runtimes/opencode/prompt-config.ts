import { sessionEnvironment } from "../../shared/environment.js";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { UnsupportedOptionError } from "../../contracts/errors.js";
import type { SessionOptions } from "../../contracts/session.js";
import { processFailure } from "../../shared/executable/diagnostics.js";
import { runExecutable, type ExecutableRunner } from "../../shared/executable/run.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import { privateTempDir } from "../../shared/private-temp.js";

export interface OpenCodePromptConfig {
  readonly options: SessionOptions;
  /** v1: the one agent whose prompt was replaced. */
  readonly agent?: string;
  /** v2 (prompt-config-v2.ts): every primary agent whose system prompt was replaced; the session must open on one of them. */
  readonly agents?: readonly string[];
  readonly cleanup: () => Promise<void>;
}

export function validateOpenCodePrompts(options: SessionOptions): void {
  const option = options.systemPrompt !== undefined ? "systemPrompt" : "appendSystemPrompt";
  if (options.systemPrompt === undefined && options.appendSystemPrompt === undefined) {
    return;
  }
  if (sessionEnvironment(options.env).OPENCODE_CONFIG_CONTENT !== undefined) {
    throw new UnsupportedOptionError(option, "opencode prompt options require OPENCODE_CONFIG_CONTENT, which is already set in the effective session environment");
  }
  // An empty agent.prompt selects the built-in prompt in native request.ts.
  if (options.systemPrompt === "") {
    throw new UnsupportedOptionError("systemPrompt", "opencode treats an empty agent prompt as its built-in prompt, so it cannot replace the system prompt with an empty string");
  }
}

async function query(command: string, args: readonly string[], options: SessionOptions, run: ExecutableRunner): Promise<JsonRecord> {
  const result = await run(command, args, { cwd: options.cwd, env: sessionEnvironment(options.env), timeoutMs: 30_000 });
  const label = `opencode ${args[0] ?? "query"}`;
  if (!result.ok) {
    throw processFailure(`${label} failed while resolving the session's agent`, result.diagnostics ?? { exitCode: result.exitCode, signal: null, stderr: result.stderr });
  }
  let parsed: JsonRecord | null = null;
  try {
    parsed = asRecord(JSON.parse(result.stdout));
  } catch {
    throw new Error(`${label} returned invalid JSON while resolving the session's agent`);
  }
  if (parsed === null) {
    throw new Error(`${label} returned no object while resolving the session's agent`);
  }
  return parsed;
}

function savedAgent(exported: JsonRecord): string | undefined {
  const durable = asRecord(exported.info)?.agent;
  if (typeof durable === "string") {
    return durable;
  }
  const messages = Array.isArray(exported.messages) ? exported.messages.map((message) => asRecord(asRecord(message)?.info)) : [];
  const user = messages.findLast((message) => message?.role === "user" && typeof asRecord(message.model)?.providerID === "string" && typeof asRecord(message.model)?.modelID === "string");
  if (user !== undefined) {
    return typeof user?.agent === "string" ? user.agent : undefined;
  }
  const assistant = messages.findLast((message) => typeof message?.providerID === "string" && typeof message.modelID === "string");
  const agent = assistant?.mode ?? assistant?.agent;
  return typeof agent === "string" ? agent : undefined;
}

function existingAgent(config: JsonRecord, agent: string): string {
  // Only the two visible built-ins can be absent from resolved config. A
  // missing custom agent must not be recreated with default permissions by
  // our prompt-only overlay (including a stale saved/default agent name).
  if (agent !== "build" && agent !== "plan" && asRecord(asRecord(config.agent)?.[agent]) === null) {
    throw new UnsupportedOptionError("systemPrompt", `opencode does not define agent ${JSON.stringify(agent)} in its resolved configuration; refusing to create an agent just to override its prompt`);
  }
  return agent;
}

async function activeAgent(command: string, options: SessionOptions, run: ExecutableRunner): Promise<string> {
  const config = await query(command, ["debug", "config"], options, run);
  if (options.resume !== undefined) {
    const agent = savedAgent(await query(command, ["export", options.resume, "--sanitize"], options, run));
    if (agent !== undefined) {
      return existingAgent(config, agent);
    }
  }
  // Build is the native default without default_agent. If native selection
  // differs (disabled/renamed agents or a concurrent config change), the ACP
  // mode read-back below refuses the open rather than dropping the override.
  return existingAgent(config, typeof config.default_agent === "string" && config.default_agent !== "" ? config.default_agent : "build");
}

/** A session-owned instructions file, removed by `cleanup`. */
export async function instructionsFile(text: string | undefined): Promise<{ readonly path?: string; readonly cleanup: () => Promise<void> }> {
  // privateTempDir: a host that ends without disposing leaves it to the backstops there.
  const directory = text === undefined ? undefined : await privateTempDir("oar-opencode-prompt-");
  let removal: Promise<void> | undefined = undefined;
  const cleanup = async (): Promise<void> => {
    if (directory !== undefined) {
      removal ??= rm(directory.path, { recursive: true, force: true });
      await removal;
      // Already gone; this only takes it off the exit backstop.
      directory.remove();
    }
  };
  if (directory === undefined) { return { cleanup }; }
  const file = path.join(directory.path, "instructions.md");
  try {
    await writeFile(file, text ?? "", { mode: 0o600 });
  } catch (error) {
    await cleanup();
    throw error;
  }
  return { path: file, cleanup };
}

/** OpenCode interpolates {env:...}/{file:...} BEFORE parsing JSON. Escape only those opening braces so prompt text survives literally. */
export function configContent(overlay: JsonRecord): string {
  return JSON.stringify(overlay).replaceAll(/\{(?=env:|file:)/gu, String.raw`\u007b`);
}

/** Native config overlay only; never copy, merge or rewrite user config. */
export async function prepareOpenCodePrompts(command: string, options: SessionOptions, run: ExecutableRunner = runExecutable): Promise<OpenCodePromptConfig> {
  validateOpenCodePrompts(options);
  const agent = options.systemPrompt === undefined ? undefined : await activeAgent(command, options, run);
  const instructions = await instructionsFile(options.appendSystemPrompt);
  const overlay = {
    ...(agent === undefined ? {} : { agent: { [agent]: { prompt: options.systemPrompt } } }),
    ...(instructions.path === undefined ? {} : { instructions: [instructions.path] }),
  };
  return { options: { ...options, env: { ...options.env, OPENCODE_CONFIG_CONTENT: configContent(overlay) } }, ...(agent === undefined ? {} : { agent }), cleanup: instructions.cleanup };
}

/** The agent the ACP open reports, from the mode config option or the legacy modes block. */
export function openedAgent(response: JsonRecord): unknown {
  const config = Array.isArray(response.configOptions) ? response.configOptions.map((option) => asRecord(option)) : [];
  return config.find((option) => option?.category === "mode")?.currentValue ?? asRecord(response.modes)?.currentModeId;
}


export function verifyOpenCodeAgent(response: JsonRecord, expected: string): void {
  const actual = openedAgent(response);
  if (actual !== expected) {
    throw new Error(`opencode selected agent ${actual === undefined ? "<unreported>" : JSON.stringify(actual)}, but the system prompt was configured for ${JSON.stringify(expected)}`);
  }
}
