import { appendFileSync, type default as nodeFs, mkdirSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { asRecord } from "../packages/oar/src/shared/json.js";
import PiRpcProgress from "../sea-trial/pi-rpc-progress.js";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof nodeFs>();
  return { ...fs, mkdirSync: vi.fn(fs.mkdirSync), appendFileSync: vi.fn(fs.appendFileSync), renameSync: vi.fn(fs.renameSync), writeFileSync: vi.fn(fs.writeFileSync), writeSync: vi.fn(fs.writeSync) };
});

afterEach(() => { vi.resetAllMocks(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const denied = (): never => { throw Object.assign(new Error("synthetic file lock"), { code: "EPERM" }); };

test("a short file lock is retried without losing the active snapshot", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oar-pi-progress-retry-"));
  vi.stubEnv("OAR_PI_RPC_DIAGNOSTICS", directory);
  try {
    vi.mocked(renameSync).mockImplementationOnce(denied).mockImplementationOnce(denied);
    new PiRpcProgress().onTestRunStart();
    expect(renameSync).toHaveBeenCalledTimes(3);
    const snapshot = await readFile(path.join(directory, "active-tests.json"), "utf8");
    expect(JSON.parse(snapshot)).toEqual([]);
    expect(await readFile(path.join(directory, "tests.jsonl"), "utf8")).not.toContain("diagnostic_write_failed");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// oxlint-disable-next-line max-statements -- Check the failure evidence and recovery against real files.
test("an exhausted file lock is recorded without throwing and a later write recovers", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oar-pi-progress-locked-"));
  vi.stubEnv("OAR_PI_RPC_DIAGNOSTICS", directory);
  const output = vi.mocked(writeSync).mockReturnValue(0);
  try {
    vi.mocked(renameSync).mockImplementationOnce(denied).mockImplementationOnce(denied).mockImplementationOnce(denied);
    const reporter = new PiRpcProgress();
    expect(() => { reporter.onTestRunStart(); }).not.toThrow();
    expect(renameSync).toHaveBeenCalledTimes(3);
    const contents = await readFile(path.join(directory, "tests.jsonl"), "utf8");
    const records = contents.trim().split("\n").map((line) => asRecord(JSON.parse(line)));
    expect(records).toContainEqual(expect.objectContaining({ kind: "diagnostic_write_failed", operation: "rename", code: "EPERM", attempts: 3 }));
    expect(output).toHaveBeenCalledWith(process.stdout.fd, expect.stringContaining('"diagnostic_write_failed"'));
    reporter.onTestRunEnd();
    const snapshot = await readFile(path.join(directory, "active-tests.json"), "utf8");
    expect(JSON.parse(snapshot)).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.each([
  ["mkdir", mkdirSync], ["append", appendFileSync], ["snapshot", writeFileSync],
] as const)("%s failure and a closed log pipe cannot escape the reporter", async (operation, failing) => {
  const directory = await mkdtemp(path.join(tmpdir(), "oar-pi-progress-unwritable-"));
  vi.stubEnv("OAR_PI_RPC_DIAGNOSTICS", directory);
  try {
    const output = vi.mocked(writeSync).mockImplementation(denied);
    vi.mocked(failing).mockImplementation(denied);
    expect(() => { new PiRpcProgress().onTestRunStart(); }).not.toThrow();
    expect(output).toHaveBeenCalledWith(process.stdout.fd, expect.stringContaining(`"operation":"${operation}"`));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
