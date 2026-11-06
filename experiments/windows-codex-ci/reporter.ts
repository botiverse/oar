import { availableParallelism } from "node:os";
import path from "node:path";
import type { Reporter, TestCase, TestModule, Vitest } from "vitest/node";
import { codexPhaseRecord } from "../../sea-trial/harness/codex-phases.js";

/** Parent-process records survive a blocked test worker. */
export default class Progress implements Reporter {
  onInit(vitest: Vitest): void {
    codexPhaseRecord("vitest_config", {
      node: process.version, availableParallelism: availableParallelism(),
      requestedWorkers: process.env.OAR_CODEX_WORKERS ?? "default",
      configuredMaxWorkers: Number.isFinite(vitest.config.maxWorkers) ? vitest.config.maxWorkers : null,
      pool: vitest.config.pool,
      testTimeout: vitest.config.testTimeout, hookTimeout: vitest.config.hookTimeout,
    });
  }
  onTestModuleQueued(module: TestModule): void { codexPhaseRecord("module_queued", { file: path.relative(process.cwd(), module.moduleId) }); }
  onTestModuleEnd(module: TestModule): void { codexPhaseRecord("module_end", { file: path.relative(process.cwd(), module.moduleId) }); }
  onTestCaseReady(test: TestCase): void { codexPhaseRecord("test_start", { test: test.fullName, file: path.relative(process.cwd(), test.module.moduleId) }); }
  onTestCaseResult(test: TestCase): void { codexPhaseRecord("test_end", { test: test.fullName, file: path.relative(process.cwd(), test.module.moduleId), state: test.result().state, elapsedMs: test.diagnostic()?.duration ?? null }); }
  onTestRunEnd(): void { codexPhaseRecord("vitest_end"); }
}
