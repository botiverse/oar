import path from "node:path";
import { environmentValue, sessionEnvironment } from "../../shared/environment.js";
import { environmentHome } from "../../shared/environment-home.js";

/**
 * Pi reads `$PI_PACKAGE_DIR/package.json` for its reported `--version`,
 * themes, and bundled assets. Embedding hosts (such as Node SEA runtimes)
 * set `PI_PACKAGE_DIR` for their own package; inheriting it into a Pi
 * subprocess spoofs `--version` and breaks asset lookup. Strip inherited
 * `PI_PACKAGE_DIR` by default while honoring an explicit caller-supplied
 * `env.PI_PACKAGE_DIR` (for example on Nix/Guix).
 */
export function piSubprocessEnvOverlay(env: Readonly<Record<string, string | null>> | undefined): Readonly<Record<string, string | null>> {
  return { PI_PACKAGE_DIR: null, ...env };
}

/** Resolved environment for Pi subprocesses (probes, RPC sessions/readers, upgrades). */
export function piSubprocessEnv(overlay?: Readonly<Record<string, string | null>>): NodeJS.ProcessEnv {
  return sessionEnvironment(piSubprocessEnvOverlay(overlay));
}

/** Resolve Pi's home and agent configuration directories for a target platform and env. */
export function piAgentDirectories(
  env: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform = process.platform,
  home?: string,
): { readonly baseHome: string; readonly agentDir: string } {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const baseHome = home ?? environmentValue(env, platform === "win32" ? "USERPROFILE" : "HOME", platform) ?? environmentHome(env);
  const configured = [
    environmentValue(env, "OAR_PI_AGENT_DIR", platform),
    environmentValue(env, "PI_CODING_AGENT_DIR", platform),
  ].find((value) => value !== undefined && value.length > 0);
  return { baseHome, agentDir: configured ?? paths.join(baseHome, ".pi", "agent") };
}
