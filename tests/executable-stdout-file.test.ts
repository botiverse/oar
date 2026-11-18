import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runExecutable } from "../packages/oar/src/shared/executable/run.js";

// stdout writes to POSIX pipes are asynchronous. Immediate exit loses their pending bytes.
// oxlint-disable-next-line max-statements -- Keep pipe and file controls in one process observation.
test("a file descriptor retains a large native write without a pipe drain", async () => {
  const root = await mkdtemp(join(tmpdir(), "oar-stdout-file-"));
  const path = join(root, "catalog.json");
  const file = await open(path, "wx", 0o600);
  const source = 'process.stdout.write(JSON.stringify([{ name: "fixture", content: "x".repeat(1024 * 1024) }])); process.exit(0);';
  const expected = JSON.stringify([{ name: "fixture", content: "x".repeat(1024 * 1024) }]);
  try {
    const pipe = await runExecutable(process.execPath, ["-e", source]);
    expect(pipe.ok).toBe(true);
    if (process.platform !== "win32") {
      expect(Buffer.byteLength(pipe.stdout)).toBeLessThan(Buffer.byteLength(expected));
      expect(() => { JSON.parse(pipe.stdout); }).toThrow();
    }
    const captured = await runExecutable(process.execPath, ["-e", source], { stdoutFd: file.fd });
    expect(captured).toEqual({ ok: true, stdout: "", stderr: "", exitCode: null });
    expect(await readFile(path, "utf8")).toBe(expected);
  } finally { await file.close(); await rm(root, { recursive: true, force: true }); }
});
