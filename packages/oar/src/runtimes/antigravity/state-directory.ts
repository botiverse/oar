import path from "node:path";
import { environmentValue } from "../../shared/environment.js";

/** agy 1.5.9 ignores GEMINI_HOME itself; only its ACP command accepts this flag. */
export function antigravityStateArgs(env: Readonly<NodeJS.ProcessEnv>, platform: NodeJS.Platform = process.platform): readonly string[] {
  const directory = environmentValue(env, "GEMINI_HOME", platform);
  return directory === undefined || directory === "" ? [] : ["--gemini-dir", directory];
}

/** Non-ACP commands cannot select a profile: never let them inspect a different one. */
export function antigravityUsesDefaultState(env: Readonly<NodeJS.ProcessEnv>, platform: NodeJS.Platform = process.platform): boolean {
  const directory = environmentValue(env, "GEMINI_HOME", platform);
  if (directory === undefined || directory === "") { return true; }
  const home = environmentValue(env, platform === "win32" ? "USERPROFILE" : "HOME", platform);
  if (home === undefined || home === "") { return false; }
  const paths = platform === "win32" ? path.win32 : path.posix;
  const requested = paths.resolve(directory);
  const native = paths.resolve(home, ".gemini");
  return platform === "win32" ? requested.toLowerCase() === native.toLowerCase() : requested === native;
}

export const ANTIGRAVITY_STATE_QUERY_UNAVAILABLE = "agy models cannot select GEMINI_HOME; isolate HOME (USERPROFILE on Windows) for authentication and usage queries";
