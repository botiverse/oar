import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

/** Some runtimes report the intended filename before saving their first turn. */
export function sessionFileLocator(path: unknown, redact: (value: string) => string): () => Promise<string | null> {
  return async () => {
    // A path carrying a credential cannot be returned intact to the host.
    if (typeof path !== "string" || !isAbsolute(path) || redact(path) !== path) { return null; }
    try {
      const status = await stat(path);
      return status.isFile() ? path : null;
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) { return null; }
      throw error;
    }
  };
}
