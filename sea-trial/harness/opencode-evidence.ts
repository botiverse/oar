import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveRunDir } from "./trace.js";

const FILE_LIMIT = 4;
const BYTE_LIMIT = 1024 * 1024;

/** Retain existing synthetic-fixture logs before HOME cleanup, without changing native logging. */
export async function retainOpencodeLogs(dataHome: string): Promise<void> {
  try {
    const destination = path.join(resolveRunDir(), "native-opencode", randomUUID());
    await mkdir(destination, { recursive: true });
    const source = path.join(dataHome, "opencode", "log");
    const entries = await readdir(source, { withFileTypes: true }).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") { return []; }
      throw error;
    });
    const names = entries.filter(entry => entry.isFile() && entry.name.endsWith(".log"))
      .map(entry => entry.name).toSorted().toReversed();
    const files = await Promise.all(names.slice(0, FILE_LIMIT).map(async (name) => {
      try {
        const handle = await open(path.join(source, name), "r");
        try {
          const { size } = await handle.stat();
          const ranges = size <= BYTE_LIMIT
            ? [{ offset: 0, length: size, file: name }]
            : [{ offset: 0, length: BYTE_LIMIT / 2, file: `${name}.head` },
              { offset: size - BYTE_LIMIT / 2, length: BYTE_LIMIT / 2, file: `${name}.tail` }];
          const segments = [];
          for (const range of ranges) {
            // oxlint-disable-next-line no-await-in-loop -- At most two bounded reads share this file handle.
            const { buffer, bytesRead } = await handle.read({ buffer: Buffer.alloc(range.length), position: range.offset });
            // oxlint-disable-next-line no-await-in-loop -- Preserve each segment before recording its byte range.
            await writeFile(path.join(destination, range.file), buffer.subarray(0, bytesRead));
            segments.push({ file: range.file, offset: range.offset, bytes: bytesRead });
          }
          return { name, sourceBytes: size, segments, truncated: segments.reduce((sum, segment) => sum + segment.bytes, 0) !== size };
        } finally { await handle.close(); }
      } catch {
        // Settle every open handle before the caller can remove HOME, even if one copy failed.
        return { name, error: "could_not_retain" };
      }
    }));
    await writeFile(path.join(destination, "manifest.json"), JSON.stringify({
      at: Date.now(), files, omittedFiles: Math.max(0, names.length - FILE_LIMIT),
    }, null, 2));
  } catch {
    // A diagnostic failure must not replace the test's result or prevent HOME cleanup.
    process.stderr.write("[oar fixture] OpenCode native logs could not be retained\n");
  }
}
