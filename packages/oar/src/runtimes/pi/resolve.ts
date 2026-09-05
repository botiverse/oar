import { join, resolve } from "node:path";

/*
 * pi resume + model resolution (SDK 0.84.2, pi-mono v0.84.2 914cf1472):
 * pi persists sessions as FILES under
 * <agentDir>/sessions/--<cwd slug>--/*.jsonl and opens them by path
 * (SessionManager.open), not by id. The id OAR reports (AgentSession.sessionId)
 * is the file's header id, and SessionManager.list(cwd, dir) reads it back per
 * file, so resume is "list the cwd's session dir, match the id, open the path".
 * Models are only unique per provider, so options.model is the same
 * `provider/model` spelling `oar models pi` lists and pi's `--model` accepts.
 */

/** Structural slice of pi's SessionInfo the lookup reads. */
export interface PiSessionInfo {
  readonly id: string;
  readonly path: string;
}

/** Structural slice of `SessionManager.list`; kept narrow for tests. */
export interface PiSessionLister {
  list(cwd: string, sessionDir?: string): Promise<readonly PiSessionInfo[]>;
}

/** Structural slice of `ModelRuntime.getModel`; kept generic for tests. */
export interface PiModelLookup<TModel> {
  getModel(provider: string, modelId: string): TModel | undefined;
}

/**
 * Mirrors pi's unexported `getDefaultSessionDirPath` (session-manager.js
 * 0.84.2): the cwd is resolved, its leading separator dropped, every `/ \ :`
 * turned into `-`, and wrapped in `--…--` under `<agentDir>/sessions`. Kept
 * in lock-step so the agent-dir pin (OAR_PI_AGENT_DIR) and pi's own CLI land
 * sessions in the same directory.
 */
export function piSessionDir(cwd: string, agentDir: string): string {
  const slug = resolve(cwd).replace(/^[/\\]/u, "").replaceAll(/[/\\:]/gu, "-");
  return join(resolve(agentDir), "sessions", `--${slug}--`);
}

/**
 * Session id → session file. Listing is per cwd because pi's directory is
 * per cwd: a session started elsewhere is not found here, and the error says
 * where it looked so the caller can tell "wrong cwd" from "never persisted"
 * (pi writes the file on the first message, so an unused session has none).
 */
export async function piFindSessionFile(
  lister: PiSessionLister,
  id: string,
  cwd: string,
  sessionDir: string,
): Promise<string> {
  const sessions = await lister.list(cwd, sessionDir);
  const found = sessions.find((session) => session.id === id);
  if (found === undefined) {
    throw new Error(
      `pi session ${id} not found: no session file with that id under ${sessionDir} `
      + `(${sessions.length} session(s) there for cwd ${cwd}; pi persists a session on its first message)`,
    );
  }
  return found.path;
}

/** Splits `provider/model` at the first slash; model ids may themselves contain slashes. */
export function splitPiModelId(model: string): { provider: string; modelId: string } {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    throw new Error(
      `pi model must be spelled provider/model as listed by \`oar models pi\`; got ${JSON.stringify(model)}`,
    );
  }
  return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
}

/**
 * `provider/model` → pi Model through the session's ModelRuntime (extension
 * registrations included, since the runtime comes from
 * createAgentSessionServices). Unknown is an error rather than a fallback:
 * pi would otherwise pick its own default and the caller's choice would
 * silently not apply.
 */
export function piResolveModel<TModel>(lookup: PiModelLookup<TModel>, model: string): TModel {
  const { provider, modelId } = splitPiModelId(model);
  const found = lookup.getModel(provider, modelId);
  if (found === undefined) {
    throw new Error(
      `pi model ${model} is not registered: provider ${provider} has no model ${modelId} `
      + "(see `oar models pi` for the usable list)",
    );
  }
  return found;
}
