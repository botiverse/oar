import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { SessionOptions } from "../../contracts/session.js";
import { sessionEnvironment } from "../../shared/environment.js";
import { spawnLineProcess, type LineProcess } from "../../shared/executable/index.js";
import type { JsonRecord } from "../../shared/json.js";
import { privateTempDir, type PrivateTempDir } from "../../shared/private-temp.js";
import { dshBridgeSource } from "./bridge.js";
import { acquireDshProfile } from "./profile-startup.js";

export interface LaunchedDsh {
  readonly child: LineProcess & { profileReady(): void };
  readonly directory: PrivateTempDir;
}

/**
 * Sessions run without approval gates like every OAR runtime (`Session` scope
 * notes): nobody sits at a prompt, and DSH rejects an action needing approval. A
 * host that names its own mode for this session keeps it.
 */
export function dshEnvironment(env: SessionOptions["env"]): NodeJS.ProcessEnv {
  const explicit = env?.DSH_PERMISSION_MODE;
  return { ...sessionEnvironment(env), ...(typeof explicit === "string" ? {} : { DSH_PERMISSION_MODE: "danger-full-access" }) };
}

const SESSION_LOG_PLUGIN_ID = "session-log-deepseek";
const SESSION_LOG_PLUGIN_NAME = "@deepseek-ai/dsh-session-log-deepseek";

export interface DshLaunchOptions {
  readonly mcpRows?: readonly JsonRecord[];
  readonly disableSessionLogUpload?: boolean;
  readonly signal?: AbortSignal;
}

/**
 * One owned `dsh --profile acp` process with the ACP protocol plugin off and the
 * bridge on. The profile supplies the native core and its stdin shutdown; no ACP
 * message is exchanged. The overlay is an invocation layer: it edits no user file.
 */
export async function launchDsh(command: string, cwd: string, env: NodeJS.ProcessEnv, options: DshLaunchOptions = {}): Promise<LaunchedDsh> {
  const { mcpRows = [], disableSessionLogUpload = false, signal } = options;
  const directory = await privateTempDir("oar-dsh-");
  let release: ((ready: boolean) => void) | undefined = undefined;
  try {
    const bridge = path.join(directory.path, "bridge.mjs");
    const patch = path.join(directory.path, "patch.json");
    await writeFile(bridge, dshBridgeSource, { mode: 0o600, flag: "wx" });
    const bridgeConfig = {
      mcpEntries: mcpRows.map((row) => row.id),
      ...(disableSessionLogUpload ? { sessionLogPlugin: { id: SESSION_LOG_PLUGIN_ID, name: SESSION_LOG_PLUGIN_NAME } } : {}),
    };
    const patchRows: readonly unknown[] = [
      { id: "acp", disabled: true },
      { insert: [...mcpRows, { id: "oar-dsh-bridge", name: pathToFileURL(bridge).href, config: bridgeConfig }] },
      ...(disableSessionLogUpload ? [{ id: SESSION_LOG_PLUGIN_ID, name: SESSION_LOG_PLUGIN_NAME, config: { enabled: false } }] : []),
    ];
    await writeFile(patch, JSON.stringify(patchRows), { mode: 0o600, flag: "wx" });
    const finish = await acquireDshProfile(env, cwd, signal);
    release = finish;
    signal?.throwIfAborted();
    const child = spawnLineProcess(command, ["--profile", "acp", "--patch", patch], { cwd, env, killTree: true, shutdown: "stdin" });
    child.onExit(() => { finish(false); directory.remove(); });
    await child.spawned;
    return { child: { ...child, profileReady: () => { finish(true); } }, directory };
  } catch (error) { release?.(false); directory.remove(); throw error; }
}
