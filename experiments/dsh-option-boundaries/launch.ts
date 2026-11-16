import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { dshBridgeSource } from "../../packages/oar/src/runtimes/dsh/bridge.js";
import { spawnLineProcess, type LineProcess } from "../../packages/oar/src/shared/executable/index.js";
import { privateTempDir, type PrivateTempDir } from "../../packages/oar/src/shared/private-temp.js";

/** Probe-only bypass of the public launcher refusal. No production session calls this. */
export async function launchProbe(command: string, cwd: string, options: { env: NodeJS.ProcessEnv; args: readonly string[] }): Promise<{ child: LineProcess; directory: PrivateTempDir }> {
  const { env, args } = options;
  const directory = await privateTempDir("oar-dsh-probe-");
  try {
    const bridge = path.join(directory.path, "bridge.mjs");
    const patch = path.join(directory.path, "patch.json");
    await writeFile(bridge, dshBridgeSource, { mode: 0o600 });
    await writeFile(patch, JSON.stringify([{ id: "acp", disabled: true }, { insert: [{ id: "oar-dsh-bridge", name: pathToFileURL(bridge).href, config: { mcpEntries: [] } }] }]), { mode: 0o600 });
    const child = spawnLineProcess(command, ["--profile", "acp", "--patch", patch, ...args], { cwd, env, killTree: true, shutdown: "stdin" });
    child.onExit(() => { directory.remove(); });
    await child.spawned;
    return { child, directory };
  } catch (error) { directory.remove(); throw error; }
}
