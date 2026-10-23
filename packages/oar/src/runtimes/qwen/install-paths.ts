import { homedir } from "node:os";
import path from "node:path";
import { installDir } from "../../shared/install.js";

/** The standalone installer's location variables also apply to discovery and permission checks. */
export function qwenInstallPaths(): { readonly bin: string; readonly library: string } {
  const root = installDir(process.env.QWEN_INSTALL_ROOT, path.join(homedir(), ".local"));
  const parent = installDir(process.env.QWEN_INSTALL_LIB_PARENT, path.join(root, "lib"));
  return {
    bin: installDir(process.env.QWEN_INSTALL_BIN_DIR, path.join(root, "bin")),
    library: installDir(process.env.QWEN_INSTALL_LIB_DIR, path.join(parent, "qwen-code")),
  };
}
