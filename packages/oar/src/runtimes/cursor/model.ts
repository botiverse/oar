import { UnsupportedOptionError } from "../../contracts/errors.js";
import type { RefusedSessionOptions } from "../../contracts/runtime.js";
import { resolvedAdditionalDirectories } from "../../shared/additional-directories.js";
import type { McpServer, SessionOptions } from "../../contracts/session.js";
import { checkMcpServerNames, givenMcpServers, isHttpMcpServer } from "../../shared/mcp-servers.js";
import { cursorOpenFailure, cursorResumeFailure } from "./failure.js";
import type { CursorAgent, CursorMcpServerConfig, CursorSdk, ModelListItem, ModelSelection } from "./sdk.js";

/**
 * Cursor's catalog (`Cursor.models.list()`, SDK 1.0.35) gives each model its
 * own parameters, and the reasoning one has a different id per family:
 * `effort` (Claude 5, Grok 4.6), `reasoning` (GPT), `reasoning_effort`
 * (Grok 4.7, Gemini 3.8, Claude Sonnet 5.5). Several Claude models also have
 * a `thinking` on/off switch; the level menu wins over it, and a model whose
 * only reasoning parameter is the switch (claude-haiku-4-5) keeps it.
 */
const LEVEL_PARAMETERS = ["effort", "reasoning", "reasoning_effort"] as const;
const SWITCH_PARAMETER = "thinking";
const EFFORT_PARAMETERS: readonly string[] = [...LEVEL_PARAMETERS, SWITCH_PARAMETER];

/** The catalog's "Auto" entry; a local agent needs a model, and this is the one Cursor picks for the user. */
export const CURSOR_DEFAULT_MODEL = "default";

export function cursorEffortParameter(model: ModelListItem): { readonly id: string; readonly levels: readonly string[] } | null {
  const parameters = model.parameters ?? [];
  for (const id of EFFORT_PARAMETERS) {
    const parameter = parameters.find((entry) => entry.id === id);
    if (parameter !== undefined) {
      return { id, levels: parameter.values.map((value) => value.value) };
    }
  }
  return null;
}

/** The effort a selection carries, by the same parameter preference. */
export function cursorSelectionEffort(selection: ModelSelection | undefined): string | null {
  const params = selection?.params ?? [];
  for (const id of EFFORT_PARAMETERS) {
    const param = params.find((entry) => entry.id === id);
    if (param !== undefined) {
      return param.value;
    }
  }
  return null;
}

function findModel(models: readonly ModelListItem[], id: string): ModelListItem | undefined {
  return models.find((model) => model.id === id || model.aliases?.includes(id) === true);
}

/**
 * Options the SDK cannot honor, refused before anything opens. SDK 1.0.35
 * types a `systemPrompt`, but a local agent's run fails with "unknown option
 * '--system-prompt'" (probed 2026-10-03), and there is no append.
 */
export const cursorRefusedSessionOptions: RefusedSessionOptions = {
  goals: "This runtime interface exposes no structured native goal controls",
  endTurnProcessesOnAbort: "Cursor runs in the host process through its SDK, so OAR owns no runtime process tree to read for one turn",
  outputSchema: "Cursor SDK exposes no final-output schema option",
  name: "cursor exposes no verified session name setting",
  serviceTier: "cursor exposes no verified per-session service-tier setting and readback",
  systemPrompt: "Cursor's SDK runs no system prompt override for a local agent",
  appendSystemPrompt: "Cursor's SDK runs no system prompt override for a local agent",
  env: "Cursor runs in this process and its SDK takes no environment for the agent's tools; SessionOptions.env is unsupported",
  launchArgs: "Cursor runs in this process through its SDK; there is no runtime command line to add arguments to",
};

/**
 * The selection a session opens with. A local agent always needs one, and a
 * resumed agent does not restore its own, so on resume without a model the
 * agent's latest recorded run says what it ran. A requested effort is
 * checked against the model's own parameter menu, because the SDK passes an
 * unknown value through unchecked and reports it back as given (probed
 * 2026-10-03: `reasoning: "ludicrous"` ran and came back verbatim). It
 * replaces only that parameter: the other parameters stay as the resumed run
 * had them, or as the catalog's default variant sets them (a `thinking`
 * switch stays on beside an `effort` level).
 */
export async function cursorModelSelection(sdk: CursorSdk, options: SessionOptions): Promise<ModelSelection> {
  const base = options.model === undefined && options.resume !== undefined
    ? await latestRunModel(sdk, options.resume, options.cwd)
    : undefined;
  const id = options.model ?? base?.id ?? CURSOR_DEFAULT_MODEL;
  if (options.effort === undefined) {
    return base ?? { id };
  }
  const model = findModel(await sdk.Cursor.models.list(), id);
  if (model === undefined) {
    throw new Error(`Cursor does not list model ${id}, so effort ${options.effort} cannot be checked`);
  }
  const parameter = cursorEffortParameter(model);
  if (parameter === null) {
    throw new Error(`Cursor model ${model.id} has no effort setting; requested effort ${options.effort}`);
  }
  if (!parameter.levels.includes(options.effort)) {
    throw new Error(`Cursor model ${model.id} does not offer effort ${options.effort}; it lists ${parameter.levels.join(", ")}`);
  }
  const others = base?.params ?? model.variants?.find((variant) => variant.isDefault === true)?.params ?? [];
  const kept = others.filter((param) => param.id !== parameter.id);
  return { id: model.id, params: [...kept, { id: parameter.id, value: options.effort }] };
}

async function latestRunModel(sdk: CursorSdk, agentId: string, cwd: string): Promise<ModelSelection | undefined> {
  let latest: { readonly model?: ModelSelection; readonly createdAt?: number } | null = null;
  let cursor: string | null = null;
  do {
    // oxlint-disable-next-line no-await-in-loop -- pages are sequential by construction.
    const page: Awaited<ReturnType<CursorSdk["Agent"]["listRuns"]>> = await sdk.Agent.listRuns(agentId, { runtime: "local", cwd, ...(cursor === null ? {} : { cursor }) })
      .catch((error: unknown) => { throw cursorResumeFailure(error, agentId, "Agent.listRuns"); });
    for (const run of page.items) {
      if (run.model !== undefined && (latest === null || (run.createdAt ?? 0) >= (latest.createdAt ?? 0))) {
        latest = run;
      }
    }
    cursor = page.nextCursor === undefined || page.nextCursor === "" ? null : page.nextCursor;
  } while (cursor !== null);
  return latest?.model;
}

/** Preserve native name validation while giving hosts the common option error.
 * All other SDK failures retain their original type and details. */
export function cursorToolDenialError(error: unknown, options: SessionOptions): unknown {
  if (options.disallowedTools !== undefined && error instanceof Error && error.name === "ConfigurationError" && error.message.includes("`disallowedTools`")) {
    return new UnsupportedOptionError("disallowedTools", error.message);
  }
  return error;
}

/**
 * SessionOptions.mcpServers as the SDK's `mcpServers` record, keyed by name:
 * stdio `{type: "stdio", command, args, env}`, http `{type: "http", url,
 * headers}`. Given on create and again on resume (the SDK keeps none for an
 * agent). Cursor's local agent called both forms' tools and the credentials
 * reached the servers ([env] SDK 1.3.1, Linux, 2026-11-11,
 * experiments/cursor-mcp.ts). Throws on a list no runtime can attach.
 */
export function cursorMcpServers(servers: readonly McpServer[]): Record<string, CursorMcpServerConfig> {
  checkMcpServerNames(servers);
  return Object.fromEntries(servers.map((server) => [server.name, isHttpMcpServer(server)
    ? { type: "http", url: server.url, ...(server.headers === undefined ? {} : { headers: { ...server.headers } }) }
    : { type: "stdio", command: server.command, args: [...server.args ?? []], ...(server.env === undefined ? {} : { env: { ...server.env } }) }]));
}

/**
 * The session's local agent, created or resumed with the selected model, the
 * disallowed tools and no sandbox, as every OAR session runs by default
 * (contracts/session.ts): without this a `~/.cursor/sandbox.json` would turn
 * one on. A refused tool name rejects as an `UnsupportedOptionError`, a key
 * Cursor refuses as a `RuntimeFailureError` (failure.ts).
 */
export async function openCursorAgent(sdk: CursorSdk, options: SessionOptions): Promise<CursorAgent> {
  const directories = resolvedAdditionalDirectories(options);
  const mcpServers = givenMcpServers(options.mcpServers);
  const agentOptions = {
    model: await cursorModelSelection(sdk, options),
    ...(options.disallowedTools === undefined ? {} : { disallowedTools: [...options.disallowedTools] }),
    ...(mcpServers === null ? {} : { mcpServers: cursorMcpServers(mcpServers) }),
    local: {
      cwd: options.cwd,
      ...(directories.length === 0 ? {} : { dirs: directories }),
      ...(options.userConfiguration === "exclude" ? { settingSources: [] } : {}),
      sandboxOptions: { enabled: false },
    },
  };
  const opening = options.resume === undefined ? sdk.Agent.create(agentOptions) : sdk.Agent.resume(options.resume, agentOptions);
  return opening.catch((error: unknown) => {
    if (options.resume !== undefined) {
      const missing = cursorResumeFailure(error, options.resume, "Agent.resume");
      if (missing !== error) { throw missing; }
    }
    const denial = cursorToolDenialError(error, options);
    throw denial === error ? cursorOpenFailure(error) : denial;
  });
}
