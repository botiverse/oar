import path from "node:path";
import { environmentHome } from "../../shared/environment-home.js";
import { environmentValue } from "../../shared/environment.js";
import { NativeHomeInitialization, type FinishInitialization } from "../../shared/native-home-initialization.js";

import { DSH_READY_TIMEOUT_MS } from "./control.js";

const profiles = new NativeHomeInitialization("package.json");

/** DSH expands tilde against the child home and resolves relative overrides against its cwd. */
export async function acquireDshProfile(env: NodeJS.ProcessEnv, cwd: string, signal = AbortSignal.timeout(DSH_READY_TIMEOUT_MS)): Promise<FinishInitialization> {
  const userHome = environmentHome(env);
  const configured = environmentValue(env, "DSH_HOME");
  let home = configured === undefined || configured.trim() === "" ? path.join(userHome, ".dsh") : configured;
  if (home === "~") { home = userHome; }
  else if (home.startsWith("~/") || home.startsWith("~\\")) { home = path.join(userHome, home.slice(2)); }
  const release = await profiles.acquire(path.resolve(cwd, home, "profiles", "acp"), signal);
  return release;
}
