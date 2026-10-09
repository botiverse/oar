import { join } from "node:path";
import { getAgentDir, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { configurePiHttp } from "./http.js";
import { piAgentDir } from "./resolve.js";

/** Where a facade's `ModelRuntime` keeps credentials and custom providers; both default into the agent dir. */
export interface PiModelRuntimePaths {
  /** Path to Pi's `auth.json`; defaults to `auth.json` in the agent dir. */
  readonly authPath?: string;
  /** Path to Pi's `models.json`; defaults to `models.json` in the agent dir; `null` disables the static config. */
  readonly modelsPath?: string | null;
}

type ModelRuntimeOptions = NonNullable<Parameters<typeof ModelRuntime.create>[0]>;

/**
 * A `ModelRuntime` for a facade, reading the same agent dir as a session:
 * `OAR_PI_AGENT_DIR`, else pi's own (`PI_CODING_AGENT_DIR` or `~/.pi/agent`).
 * Left to pi, `auth.json` and `models.json` would come from pi's own dir even
 * with `OAR_PI_AGENT_DIR` set, so a login would not reach the next session.
 * Network calls (OAuth, catalog refresh) need the proxy plane first, from
 * that dir's settings (see http.ts).
 */
export async function piFacadeRuntime(paths: PiModelRuntimePaths, options: Omit<ModelRuntimeOptions, "authPath" | "modelsPath">): Promise<ModelRuntime> {
  const agentDir = piAgentDir(getAgentDir);
  await configurePiHttp(SettingsManager.create(process.cwd(), agentDir));
  return ModelRuntime.create({
    ...options,
    authPath: paths.authPath ?? join(agentDir, "auth.json"),
    // pi reads an absent modelsPath as its own dir's; null is what disables it.
    modelsPath: paths.modelsPath === undefined ? join(agentDir, "models.json") : paths.modelsPath,
  });
}
