import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Reporter, TestCase, TestModule } from "vitest/node";

/** The reporter runs outside test workers, including a worker with a blocked event loop. */
export default class PiRpcProgress implements Reporter {
  private readonly directory = process.env.OAR_PI_RPC_DIAGNOSTICS;
  private readonly active = new Map<string, { name: string; file: string; startedAt: string }>();

  private record(kind: string, fields: Record<string, unknown> = {}): void {
    if (this.directory === undefined) { return; }
    mkdirSync(this.directory, { recursive: true });
    appendFileSync(path.join(this.directory, "tests.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), kind, ...fields })}\n`);
    const temporary = path.join(this.directory, "active-tests.tmp");
    writeFileSync(temporary, JSON.stringify([...this.active.values()]));
    renameSync(temporary, path.join(this.directory, "active-tests.json"));
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
