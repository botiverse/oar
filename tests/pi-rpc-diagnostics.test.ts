import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { runExecutable } from "../packages/oar/src/shared/executable/run.js";
import { asRecord } from "../packages/oar/src/shared/json.js";

const vitestEntry = pathToFileURL(path.resolve("node_modules/vitest/dist/index.js")).href;
const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

// oxlint-disable-next-line max-statements -- Exercise the actual child runner and its durable evidence together.
test("the reporter persists the name and failure of a timed-out test", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oar-pi-progress-"));
  const fixture = path.join(directory, "probe.test.ts");
  const config = path.join(directory, "vitest.config.mjs");
  try {
    await writeFile(fixture, `import { test } from ${JSON.stringify(vitestEntry)};
test("named pending fixture", async () => { await new Promise(() => {}); });`);
    await writeFile(config, `export default { root: ${JSON.stringify(directory)}, test: { include: ["probe.test.ts"], testTimeout: 100, reporters: [${JSON.stringify(path.resolve("sea-trial/pi-rpc-progress.ts"))}] } };`);
    const result = await runExecutable(process.execPath, [path.resolve("node_modules/vitest/vitest.mjs"), "run", "--config", config], {
      timeoutMs: 20_000, env: { ...process.env, OAR_PI_RPC_DIAGNOSTICS: directory },
    });
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(1);
    const contents = await readFile(path.join(directory, "tests.jsonl"), "utf8");
    const records = contents.trim().split("\n").map((line) => asRecord(JSON.parse(line)));
    expect(records, `${result.stdout}\n${result.stderr}`).toContainEqual(expect.objectContaining({ kind: "case_start", name: "named pending fixture" }));
    expect(records).toContainEqual(expect.objectContaining({ kind: "case_end", name: "named pending fixture", state: "failed" }));
    const active = await readFile(path.join(directory, "active-tests.json"), "utf8");
    expect(JSON.parse(active)).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);

// oxlint-disable-next-line max-statements -- Verify a real blocked worker is stopped without losing its name.
test.skipIf(process.platform !== "win32")("the external Windows deadline kills a blocked worker and retains its test name", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oar-pi-watchdog-"));
  const fixture = path.join(directory, "probe.test.ts");
  const config = path.join(directory, "vitest.config.mjs");
  try {
    await writeFile(fixture, `import { test } from ${JSON.stringify(vitestEntry)};
test("blocked native worker", async () => { await new Promise(r => setTimeout(r, 500)); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); });`);
    await writeFile(config, `export default { root: ${JSON.stringify(directory)}, test: { include: ["probe.test.ts"], testTimeout: 1000, reporters: [${JSON.stringify(path.resolve("sea-trial/pi-rpc-progress.ts"))}] } };`);
    const command = `& ${quote(process.execPath)} ${quote(path.resolve("node_modules/vitest/vitest.mjs"))} run --config ${quote(config)}`;
    const result = await runExecutable("pwsh.exe", ["-NoProfile", "-File", path.resolve("sea-trial/windows-resources.ps1"),
      "-Stage", "blocked", "-Command", command, "-OutputDirectory", directory, "-ActiveTestsPath", path.join(directory, "active-tests.json"),
      "-CaseTimeoutSeconds", "2", "-CommandTimeoutSeconds", "20", "-IntervalMs", "1000"], {
      timeoutMs: 35_000, env: { ...process.env, OAR_PI_RPC_DIAGNOSTICS: directory },
    });
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(124);
    expect(result.stdout).toContain("blocked native worker exceeded the external 2 second case deadline");
    expect(await readFile(path.join(directory, "blocked.jsonl"), "utf8")).toContain('"kind":"case_timeout"');
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}, 45_000);
