import { appendFileSync, mkdirSync, renameSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import type { Reporter, TestCase, TestModule } from "vitest/node";

const retryWait = new Int32Array(new SharedArrayBuffer(4));

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "UNKNOWN";
}

/** The reporter runs outside test workers, including a worker with a blocked event loop. */
export default class PiRpcProgress implements Reporter {
  private readonly directory = process.env.OAR_PI_RPC_DIAGNOSTICS;
  private readonly active = new Map<string, { name: string; file: string; startedAt: string }>();

  private writeFailed(operation: string, error: unknown, attempts: number): void {
    const record = `${JSON.stringify({ at: new Date().toISOString(), kind: "diagnostic_write_failed", operation, code: errorCode(error), attempts })}\n`;
    // Either destination can be unavailable. Diagnostics must not change the test result.
    try { writeSync(process.stdout.fd, `pi-rpc-progress ${record}`); } catch { /* The log pipe may be closed. */ }
    if (this.directory === undefined) { return; }
    try { appendFileSync(path.join(this.directory, "tests.jsonl"), record); } catch { /* The diagnostic directory may be unwritable. */ }
  }

  private write(operation: string, action: () => void, retry = false): boolean {
    for (let attempt = 1; ; attempt += 1) {
      try { action(); return true; } catch (error) {
        if (retry && attempt < 3 && ["EPERM", "EACCES", "EBUSY"].includes(errorCode(error))) {
          // Keep snapshots ordered while allowing a short Windows file lock to clear.
          Atomics.wait(retryWait, 0, 0, 20);
          continue;
        }
        this.writeFailed(operation, error, attempt);
        return false;
      }
    }
  }

  private record(kind: string, fields: Record<string, unknown> = {}): void {
    if (this.directory === undefined) { return; }
    const directory = this.directory;
    if (!this.write("mkdir", () => { mkdirSync(directory, { recursive: true }); })) { return; }
    this.write("append", () => { appendFileSync(path.join(directory, "tests.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), kind, ...fields })}\n`); });
    const temporary = path.join(this.directory, "active-tests.tmp");
    if (!this.write("snapshot", () => { writeFileSync(temporary, JSON.stringify([...this.active.values()])); })) { return; }
    this.write("rename", () => { renameSync(temporary, path.join(directory, "active-tests.json")); }, true);
  }

  onTestRunStart(): void { this.record("run_start"); }
  onTestModuleQueued(module: TestModule): void { this.record("module_queued", { file: module.moduleId }); }
  onTestModuleCollected(module: TestModule): void { this.record("module_collected", { file: module.moduleId }); }
  onTestModuleEnd(module: TestModule): void { this.record("module_end", { file: module.moduleId }); }

  onTestCaseReady(test: TestCase): void {
    const fields = { name: test.fullName, file: test.module.moduleId, startedAt: new Date().toISOString() };
    this.active.set(test.id, fields);
    this.record("case_start", fields);
  }

  onTestCaseResult(test: TestCase): void {
    this.active.delete(test.id);
    this.record("case_end", { name: test.fullName, file: test.module.moduleId, state: test.result().state });
  }

  onTestRunEnd(): void { this.record("run_end"); }
}
