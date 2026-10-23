import { fileURLToPath } from "node:url";
import { runExecutable } from "../../../shared/executable/index.js";
import { assertRan } from "../../../shared/executable/diagnostics.js";

import { piRpcVersion } from "./version.js";

/** Check the actual executable before starting a session or loading extensions. */
export async function piRpcLaunch(command: string | undefined, cwd: string, env: NodeJS.ProcessEnv, args: readonly string[] = []): Promise<{
  readonly command: string;
  readonly args: readonly string[];
  readonly version: string;
}> {
  const version = await piRpcVersion();
  const executable = command ?? process.execPath;
  const entry = command === undefined ? [fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"))] : [...args];
  const result = await runExecutable(executable, [...entry, "--version"], { cwd, env, timeoutMs: 15_000 });
  assertRan(result, "Cannot read the Pi RPC executable version");
  const actual = result.ok ? result.stdout.trim() : "unavailable";
  if (actual !== version) {
    throw new Error(`Pi RPC requires ${version}, matching OAR's bundled Pi; the selected command reports ${actual}. Select a Pi executable of that version with createPiRuntime({ execution: "subprocess", command }).`);
  }
  return { command: executable, args: command === undefined ? entry : [...args, "--mode", "rpc"], version };
}
