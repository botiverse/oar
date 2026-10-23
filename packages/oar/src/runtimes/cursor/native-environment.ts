import { createRequire } from "node:module";
import path from "node:path";

const SDK_PACKAGE = "@cursor/sdk";

/**
 * Resolve the SDK's native companion from the SDK itself, including pnpm
 * layouts. Returns absolute paths for the host to apply at startup, or null
 * when the packages cannot be resolved. Never changes the process environment
 * or loads the SDK. A variable specifier preserves runtime package discovery
 * when the host bundles OAR.
 */
export function cursorNativeEnvironment(): Readonly<{
  CURSOR_TREE_SITTER_VENDOR_DIR: string;
  CURSOR_RIPGREP_PATH: string;
}> | null {
  try {
    const fromSdk = createRequire(import.meta.resolve(SDK_PACKAGE));
    const root = path.dirname(fromSdk.resolve(`${SDK_PACKAGE}-${process.platform}-${process.arch}/package.json`));
    return {
      CURSOR_TREE_SITTER_VENDOR_DIR: path.join(root, "vendor"),
      CURSOR_RIPGREP_PATH: path.join(root, "bin", process.platform === "win32" ? "rg.exe" : "rg"),
    };
  } catch { return null; }
}
