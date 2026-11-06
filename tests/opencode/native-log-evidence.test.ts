/* oxlint-disable max-statements -- These controls verify retained evidence and cleanup together. */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { startOpencodeAimock } from "../../sea-trial/harness/aimock-acp.js";
import { retainOpencodeLogs } from "../../sea-trial/harness/opencode-evidence.js";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

test("native logs survive fixture HOME removal without changing provider configuration", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "oar-native-log-evidence-"));
  vi.stubEnv("OAR_TRIAL_RUN_DIR", output);
  const fixture = await startOpencodeAimock(() => {});
  let stopped = false;
  try {
    const directory = path.join(fixture.env.XDG_DATA_HOME ?? "", "opencode", "log");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "opencode.log"), "title completed\nsnapshot tracking\nmodel stream\n");
    const config = await readFile(path.join(fixture.env.XDG_CONFIG_HOME ?? "", "opencode", "opencode.json"), "utf8");
    expect(config).not.toMatch(/snapshot|logLevel/u);
    await fixture.stop(); stopped = true;
    await expect(stat(fixture.env.HOME ?? "")).rejects.toThrow();
    const [name] = await readdir(path.join(output, "native-opencode"));
    const directorySaved = path.join(output, "native-opencode", name ?? "missing");
    expect(await readFile(path.join(directorySaved, "opencode.log"), "utf8")).toBe("title completed\nsnapshot tracking\nmodel stream\n");
    const manifest = await readFile(path.join(directorySaved, "manifest.json"), "utf8");
    expect(JSON.parse(manifest)).toMatchObject({
      omittedFiles: 0, files: [{ name: "opencode.log", truncated: false }],
    });
  } finally { if (!stopped) { await fixture.stop(); } await rm(output, { recursive: true, force: true }); }
});

test("bounded retention keeps the beginning and end with explicit gaps and file omissions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "oar-native-log-budget-"));
  vi.stubEnv("OAR_TRIAL_RUN_DIR", path.join(root, "output"));
  try {
    const logs = path.join(root, "data", "opencode", "log"); await mkdir(logs, { recursive: true });
    const content = `start\n${"x".repeat(2 * 1024 * 1024)}\nend`;
    await Promise.all(["1", "2", "3", "4", "5"].map(async name => { await writeFile(path.join(logs, `${name}.log`), content); }));
    await writeFile(path.join(logs, "unrelated.json"), "not a log");
    await retainOpencodeLogs(path.join(root, "data"));
    const [name] = await readdir(path.join(root, "output", "native-opencode"));
    const saved = path.join(root, "output", "native-opencode", name ?? "missing");
    const head = await readFile(path.join(saved, "5.log.head"), "utf8");
    const tail = await readFile(path.join(saved, "5.log.tail"), "utf8");
    expect(head.startsWith("start\n")).toBe(true);
    expect(tail.endsWith("\nend")).toBe(true);
    const manifest = await readFile(path.join(saved, "manifest.json"), "utf8");
    expect(JSON.parse(manifest)).toMatchObject({
      omittedFiles: 1,
      files: ["5", "4", "3", "2"].map(file => ({
        name: `${file}.log`, truncated: true, sourceBytes: Buffer.byteLength(content),
        segments: [{ file: `${file}.log.head`, offset: 0, bytes: 524_288 },
          { file: `${file}.log.tail`, offset: Buffer.byteLength(content) - 524_288, bytes: 524_288 }],
      })),
    });
    await expect(stat(path.join(saved, "unrelated.json"))).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed evidence storage does not prevent the fixture's cleanup", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "oar-native-log-failure-"));
  vi.stubEnv("OAR_TRIAL_RUN_DIR", root);
  const fixture = await startOpencodeAimock(() => {});
  try {
    await writeFile(path.join(root, "native-opencode"), "blocked directory");
    const warning = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await expect(fixture.stop()).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledWith("[oar fixture] OpenCode native logs could not be retained\n");
    await expect(stat(fixture.env.HOME ?? "")).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
