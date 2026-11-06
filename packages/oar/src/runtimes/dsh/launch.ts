import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { SessionOptions } from "../../contracts/session.js";
import { sessionEnvironment } from "../../shared/environment.js";
import { readExecutableVersion, spawnLineProcess, type LineProcess } from "../../shared/executable/index.js";
import type { JsonRecord } from "../../shared/json.js";
import { privateTempDir, type PrivateTempDir } from "../../shared/private-temp.js";
import { dshBridgeSource } from "./bridge.js";
import { dshVersionRefusal } from "./version.js";

export interface LaunchedDsh {
  readonly child: LineProcess;
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

/** Why this executable cannot run, read from the executable when the installation names no version; null at or above the floor. */
export async function dshExecutableRefusal(command: string, version: string | undefined, env: NodeJS.ProcessEnv): Promise<string | null> {
  return dshVersionRefusal(version ?? await readExecutableVersion(command, 15_000, undefined, env));
}

/**
 * One owned `dsh --profile acp` process with the ACP protocol plugin off and the
 * bridge on. The profile supplies the native core and its stdin shutdown; no ACP
 * message is exchanged. The overlay is an invocation layer: it edits no user file.
 */
export async function launchDsh(command: string, cwd: string, env: NodeJS.ProcessEnv, mcpRows: readonly JsonRecord[] = []): Promise<LaunchedDsh> {
  const directory = await privateTempDir("oar-dsh-");
  try {
    const bridge = path.join(directory.path, "bridge.mjs");
    const patch = path.join(directory.path, "patch.json");
    await writeFile(bridge, dshBridgeSource, { mode: 0o600, flag: "wx" });
    await writeFile(patch, JSON.stringify([{ id: "acp", disabled: true }, { insert: [...mcpRows, { id: "oar-dsh-bridge", name: pathToFileURL(bridge).href, config: { mcpEntries: mcpRows.map((row) => row.id) } }] }]), { mode: 0o600, flag: "wx" });
    const child = spawnLineProcess(command, ["--profile", "acp", "--patch", patch], { cwd, env, killTree: true, shutdown: "stdin" });
    child.onExit(() => { directory.remove(); });
    await child.spawned;
    return { child, directory };
  } catch (error) { directory.remove(); throw error; }
}
