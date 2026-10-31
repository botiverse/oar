/**
 * Observe native cold-start contention independently of the prepared behavior suite.
 * OAR_OPENCODE_BIN=/pinned/opencode pnpm tsx experiments/opencode-cold-start.ts [output]
 * Two concurrent independent ACP sessions share one fresh database; repeat in
 * another HOME after one serial open/exit. No prompts, credentials or retries.
 * Any failed open/cleanup exits nonzero after retaining all observed outcomes.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { opencodeInstallation } from "../packages/oar/src/runtimes/opencode/installation.js";
import { opencodeSession } from "../packages/oar/src/runtimes/opencode/session.js";
import type { Session } from "../packages/oar/src/contracts/session.js";
import { startOpencodeAimock, type AcpAimockEnv } from "../sea-trial/harness/aimock-acp.js";
import { opencodePreparation } from "../sea-trial/harness/opencode-home.js";

const output = path.resolve(process.argv[2] ?? "oar-trial-run/opencode-cold-start");
await mkdir(output, { recursive: true });
const snapshot = await opencodeInstallation();
assert.ok(snapshot.kind === "available" && snapshot.via === "executable", JSON.stringify(snapshot));
const installation = snapshot;
interface Observation { phase: string; opened: boolean; elapsedMs: number; errors: { stage: string; message: string }[]; }
const results: Observation[] = [];
const fixtureErrors: { phase: string; message: string }[] = [];
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

async function sample(fixture: AcpAimockEnv, phase: string): Promise<void> {
  const started = performance.now();
  const observation: Observation = { phase, opened: false, elapsedMs: 0, errors: [] };
  let session: Session | undefined = undefined;
  try {
    session = await opencodeSession(installation, { cwd: fixture.env.HOME ?? process.cwd(), env: fixture.env });
    observation.opened = true;
  } catch (error) { observation.errors.push({ stage: "open", message: message(error) }); }
  finally {
    observation.elapsedMs = performance.now() - started;
    try { await session?.dispose(); }
    catch (error) { observation.errors.push({ stage: "dispose", message: message(error) }); }
    results.push(observation);
  }
}

async function compare(phase: "cold" | "prepared"): Promise<void> {
  let fixture: AcpAimockEnv | undefined = undefined;
  try {
    fixture = await startOpencodeAimock(() => {});
    if (phase === "prepared") { await opencodePreparation(fixture.env)(installation); }
    await Promise.all([sample(fixture, `${phase}-a`), sample(fixture, `${phase}-b`)]);
    assert.equal(fixture.raw.length, 0, "Startup observation must not make model requests");
  } catch (error) { fixtureErrors.push({ phase, message: message(error) }); }
  finally {
    try { await fixture?.stop(); }
    catch (error) { fixtureErrors.push({ phase: `${phase}-fixture-cleanup`, message: message(error) }); }
  }
}

await compare("cold");
await compare("prepared");
results.sort((a, b) => a.phase.localeCompare(b.phase));
const failures = results.filter((result) => result.errors.length > 0);
let coldStartFailure = "observation_incomplete";
if (results.filter((result) => result.phase.startsWith("cold")).length === 2) {
  coldStartFailure = results.some((result) => result.phase.startsWith("cold") && !result.opened) ? "observed" : "not_reproduced";
}
const report = {
  version: installation.version ?? null, platform: process.platform, arch: process.arch, node: process.version,
  concurrency: 2, results, fixtureErrors,
  coldStartFailure,
};
await writeFile(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = failures.length > 0 || fixtureErrors.length > 0 ? 1 : 0;
