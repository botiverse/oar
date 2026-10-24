import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, readdir } from "node:fs/promises";
import path from "node:path";
import type { AvailableInstallation } from "../../packages/oar/src/contracts/installation.js";
import { launchQoder, closeQoder } from "../../packages/oar/src/runtimes/qoder/launch.js";
import { qoderControl, qoderInitializeTimeoutMs } from "../../packages/oar/src/runtimes/qoder/control.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";
import { startQoderNative, type QoderNativeEnv } from "./qoder-native.js";
import { record } from "./trace.js";

interface Sample {
  readonly label: string;
  readonly kind: "ok" | "failed";
  readonly initializeMs: number;
  readonly reason?: string;
}

/** Observe slow native completion up to 90s, independently of the product's deadline. */
async function sample(command: string, fixture: QoderNativeEnv, label: string): Promise<Sample> {
  const started = performance.now();
  const child = await launchQoder(command, randomUUID(), fixture.options);
  const control = qoderControl(child, () => {}, 90_000);
  child.onLine((line) => {
    const value = asRecord(parseJson(line));
    if (value !== null) { control.consume(value); }
  });
  child.onExit(control.end);
  try {
    await control.request({ subtype: "initialize" });
    return { label, kind: "ok", initializeMs: performance.now() - started };
  } catch (error) {
    return { label, kind: "failed", initializeMs: performance.now() - started, reason: error instanceof Error ? error.message : String(error) };
  } finally { control.end(); await closeQoder(child); }
}

/** Copy only the native binary cache, never credentials, config, plugins or history. */
async function copyBinaries(source: QoderNativeEnv, target: QoderNativeEnv): Promise<number> {
  const directory = path.join(source.home, ".qoder", ".bin");
  try {
    const entries = await readdir(directory);
    await cp(directory, path.join(target.home, ".qoder", ".bin"), { recursive: true });
    return entries.length;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") { return 0; }
    throw error;
  }
}

/** Independent controls, not retries or prewarming for the behavior suite's separate HOME. */
export async function measureQoderStartup(installation: AvailableInstallation): Promise<void> {
  assert.ok(installation.via === "executable");
  const { command, version } = installation;
  const fixtures = await Promise.all(Array.from({ length: 4 }, async () => { const fixture = await startQoderNative([]); return fixture; }));
  const [baseline, seeded, freshA, freshB] = fixtures;
  assert.ok(baseline && seeded && freshA && freshB);
  const samples: Sample[] = [];
  async function measure(fixture: QoderNativeEnv, label: string): Promise<void> {
    const result = await sample(command, fixture, label);
    samples.push(result);
    const observation = { kind: "qoder_startup", platform: process.platform, arch: process.arch, node: process.version, version: version ?? null, label: result.label, outcome: result.kind, initializeMs: result.initializeMs, productDeadlineMs: qoderInitializeTimeoutMs, exceedsProductDeadline: result.initializeMs > qoderInitializeTimeoutMs, exceedsPreviousDeadline: result.initializeMs > 30_000, ...(result.reason === undefined ? {} : { reason: result.reason }) };
    record(observation);
    process.stdout.write(`${JSON.stringify(observation)}\n`);
  }
  try {
    await measure(baseline, "fresh_home_serial");
    const copiedEntries = await copyBinaries(baseline, seeded);
    record({ kind: "qoder_binary_cache_copy", copiedEntries });
    await measure(seeded, "binary_cache_only_serial");
    await measure(baseline, "same_home_serial");
    await Promise.all([measure(baseline, "same_home_parallel_a"), measure(baseline, "same_home_parallel_b")]);
    await Promise.all([measure(freshA, "fresh_home_parallel_a"), measure(freshB, "fresh_home_parallel_b")]);
    assert.ok(samples.every((result) => result.kind === "ok"), JSON.stringify(samples.filter((result) => result.kind === "failed")));
  } finally { await Promise.all(fixtures.map(async (fixture) => { await fixture.stop(); })); }
}
