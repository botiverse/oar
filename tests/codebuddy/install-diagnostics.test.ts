import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";
import { installDiagnostics } from "../fixtures/codebuddy-install-diagnostics.js";

let root = "";
let home = "";
let logs = "";
let evidence = "";
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "oar-install-evidence-"));
  home = path.join(root, "home"); logs = path.join(home, "npm-cache", "_logs"); evidence = path.join(root, "evidence");
  await mkdir(logs, { recursive: true });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

test("npm debug and timing evidence survives HOME deletion without copying unrelated files", async () => {
  const debug = "2026-11-06T00_00_00_000Z-debug-0.log";
  const timing = "2026-11-06T00_00_00_000Z-timing.json";
  await Promise.all([
    writeFile(path.join(logs, debug), "12 info run package@1.0.0 postinstall\n"),
    writeFile(path.join(logs, timing), '{"timers":{"idealTree":12}}'),
    writeFile(path.join(logs, "private.npmrc"), "private configuration"),
  ]);
  await installDiagnostics(evidence).capture(home);
  await rm(home, { recursive: true, force: true });
  const saved = await readdir(evidence);
  expect(saved.toSorted()).toEqual([debug, timing, "phases.jsonl"]);
  expect(await readFile(path.join(evidence, debug), "utf8")).toBe("12 info run package@1.0.0 postinstall\n");
  expect(await readFile(path.join(evidence, timing), "utf8")).toBe('{"timers":{"idealTree":12}}');
});

test("an oversized log retains its last stage and marks the omitted prefix", async () => {
  const name = "2026-11-06T00_00_00_000Z-debug-0.log";
  const text = `${"x".repeat(1024 * 1024)}\nlast npm stage\n`;
  await writeFile(path.join(logs, name), text);
  await installDiagnostics(evidence).capture(home);
  expect(await readFile(path.join(evidence, name), "utf8")).toBe(text.slice(-1024 * 1024));
  expect(await readFile(path.join(evidence, "phases.jsonl"), "utf8")).toContain('"truncated":true');
});

test("missing logs are recorded instead of replacing an installer error", async () => {
  await rm(logs, { recursive: true });
  await installDiagnostics(evidence).capture(home);
  const text = await readFile(path.join(evidence, "phases.jsonl"), "utf8");
  expect(asRecord(parseJson(text))).toMatchObject({ phase: "npm_logs_unavailable", pid: process.pid, code: "ENOENT" });
});

test("collected logs redact npm tokens and URL credentials", async () => {
  const name = "2026-11-06T00_00_00_000Z-debug-0.log";
  await writeFile(path.join(logs, name), "npm_0123456789abcdef0123456789abcdef https://user:password@registry.example.test/package\n");
  await installDiagnostics(evidence).capture(home);
  expect(await readFile(path.join(evidence, name), "utf8")).toBe("[redacted] https://[redacted]@registry.example.test/package\n");
});
