/* oxlint-disable typescript/promise-function-async -- Assert original promise and synchronous throw identity. */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { asRecord } from "../packages/oar/src/shared/json.js";
import { codexPhaseRecord, observeCodexPhase, setCodexPhaseContext, startCodexPhase } from "../experiments/windows-codex-ci/codex-phases.js";

let directory = "";
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "oar-codex-phases-"));
  vi.stubEnv("OAR_CODEX_PHASES", directory);
  setCodexPhaseContext(() => ({}));
});
afterEach(() => {
  setCodexPhaseContext(() => ({}));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});
function records(): Record<string, unknown>[] {
  return readFileSync(path.join(directory, `phases-${process.pid}.jsonl`), "utf8").trim().split("\n").map(line => {
    const record = asRecord(JSON.parse(line));
    if (record === null) { throw new Error("expected a phase record"); }
    return record;
  });
}

test("observation preserves promise identity, value and original rejection", async () => {
  const value = {};
  const resolved = Promise.resolve(value);
  expect(observeCodexPhase("resolved", () => resolved)).toBe(resolved);
  expect(await resolved).toBe(value);
  const error = new Error("original failure");
  const rejected = Promise.reject(error);
  expect(observeCodexPhase("rejected", () => rejected)).toBe(rejected);
  await expect(rejected).rejects.toBe(error);
  expect(records().filter(record => record.kind === "phase_end").map(record => record.outcome)).toEqual(["fulfilled", "rejected"]);
});

test("a late phase end stays with the test that started it", () => {
  const state = { file: "a.test.ts", test: "first" };
  setCodexPhaseContext(() => state);
  const end = startCodexPhase("cleanup");
  state.test = "second";
  end();
  const [start, finish] = records();
  expect(finish).toMatchObject({ kind: "phase_end", file: "a.test.ts", test: "first", id: start?.id });
});

test("disabled observation writes nothing and never asks for context", () => {
  vi.stubEnv("OAR_CODEX_PHASES", undefined);
  const context = vi.fn(() => { throw new Error("not called"); });
  setCodexPhaseContext(context);
  startCodexPhase("disabled")();
  codexPhaseRecord("disabled");
  expect(context).not.toHaveBeenCalled();
  expect(readdirSync(directory)).toEqual([]);
});

test("diagnostic write failures and broken context preserve native failure", () => {
  const file = path.join(directory, "not-a-directory");
  writeFileSync(file, "existing file");
  vi.stubEnv("OAR_CODEX_PHASES", file);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  setCodexPhaseContext(() => { throw new Error("bad diagnostic context"); });
  const original = new Error("native synchronous failure");
  expect(() => observeCodexPhase("failed", () => { throw original; })).toThrow(original);
  expect(readFileSync(file, "utf8")).toBe("existing file");
});
