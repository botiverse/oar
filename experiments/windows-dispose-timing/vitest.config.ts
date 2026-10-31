import { defineConfig } from "vitest/config";

// Deliberately omit the normal globalSetup's CIM preparation for the cold control.
export default defineConfig({ test: { include: ["experiments/windows-dispose-timing/probe.test.ts"], maxWorkers: 1, fileParallelism: false } });
