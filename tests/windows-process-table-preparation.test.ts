import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prepareWindowsProcessTable } from "../sea-trial/windows-process-table.js";
import { asRecord } from "../packages/oar/src/shared/json.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
const run = vi.mocked(spawnSync);
let dir = "";
let output = "";

function nativeResult(stdout: string): SpawnSyncReturns<string> {
  return { pid: 42, status: 0, signal: null, output: [null, stdout, ""], stdout, stderr: "" };
}

function recorded(): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(output, "utf8"));
  const record = asRecord(value);
  assert.ok(record);
  const { at, elapsedMs, ...fields } = record;
  expect(typeof at).toBe("string");
  expect(typeof elapsedMs).toBe("number");
  return fields;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "oar-windows-preparation-"));
  output = path.join(dir, "preparation.jsonl");
  run.mockReset();
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

it("does not run or create a preparation record on other platforms", () => {
  prepareWindowsProcessTable(output, "linux");
  expect(run).not.toHaveBeenCalled();
  expect(existsSync(output)).toBe(false);
});

it("requires a successful CIM query with the observer's creation identity", () => {
  run.mockReturnValue(nativeResult(JSON.stringify({ queryMs: 8.5, count: 100, selfPresent: true, selfHasCreationTime: true })));
  prepareWindowsProcessTable(output, "win32");
  expect(recorded()).toMatchInlineSnapshot(`
    {
      "error": null,
      "errorCode": null,
      "exitCode": 0,
      "kind": "windows_process_table_preparation",
      "outcome": "completed",
      "processes": 100,
      "queryMs": 8.5,
      "signal": null,
      "stderr": "",
      "timeoutMs": 60000,
    }
  `);
});

it("retains timeout details and fails preparation instead of continuing the tests", () => {
  const error = Object.assign(new Error("native preparation timed out"), { code: "ETIMEDOUT" });
  run.mockReturnValue({ ...nativeResult(""), status: null, signal: "SIGTERM", error });
  expect(() => { prepareWindowsProcessTable(output, "win32"); }).toThrow("Windows process-table preparation failed");
  expect(recorded()).toMatchInlineSnapshot(`
    {
      "error": "native preparation timed out",
      "errorCode": "ETIMEDOUT",
      "exitCode": null,
      "kind": "windows_process_table_preparation",
      "outcome": "failed",
      "signal": "SIGTERM",
      "stderr": "",
      "timeoutMs": 60000,
    }
  `);
  expect(run).toHaveBeenCalledTimes(1);
});

it.each([
  ["missing observer", JSON.stringify({ queryMs: 1, count: 20, selfPresent: false, selfHasCreationTime: false })],
  ["missing creation identity", JSON.stringify({ queryMs: 1, count: 20, selfPresent: true, selfHasCreationTime: false })],
  ["malformed output", "not JSON"],
])("fails preparation on %s without treating it as an empty successful read", (_name, stdout) => {
  run.mockReturnValue(nativeResult(stdout));
  expect(() => { prepareWindowsProcessTable(output, "win32"); }).toThrow("Windows process-table preparation failed");
  expect(recorded().outcome).toBe("failed");
});
