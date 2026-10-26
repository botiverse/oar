import { environmentValue } from "../../shared/environment.js";
import { environmentHome } from "../../shared/environment-home.js";
import path from "node:path";
import { installDir } from "../../shared/install.js";

/** The standalone installer's location variables also apply to discovery and permission checks. */
export function qwenInstallPaths(env: Readonly<NodeJS.ProcessEnv> = process.env): { readonly bin: string; readonly library: string } {
  const root = installDir(environmentValue(env, "QWEN_INSTALL_ROOT"), path.join(environmentHome(env), ".local"));
  const parent = installDir(environmentValue(env, "QWEN_INSTALL_LIB_PARENT"), path.join(root, "lib"));
  return {
    bin: installDir(environmentValue(env, "QWEN_INSTALL_BIN_DIR"), path.join(root, "bin")),
    library: installDir(environmentValue(env, "QWEN_INSTALL_LIB_DIR"), path.join(parent, "qwen-code")),
  };
}
