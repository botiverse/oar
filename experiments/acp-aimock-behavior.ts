/**
 * Shared session behavior on native ACP runtimes using a local scripted
 * provider and temporary runtime configuration, without account access.
 * Run: pnpm tsx experiments/acp-aimock-behavior.ts <antigravity|grok|kimi|opencode>
 * Pin the executable with OAR_ANTIGRAVITY_BIN, OAR_GROK_BIN, OAR_KIMI_BIN
 * or OAR_OPENCODE_BIN.
 * Antigravity also needs its matching localharness_external beside the server.
 * Account usage and standalone model catalogs deliberately stay out of
 * this subject. Their behavior cases skip; native session capabilities
 * determine the other skips. Cases and timeouts are unchanged.
 * Observed 2026-10-16: Grok 1.0.60 and OpenCode 1.19.2 pass 17 cases,
 * skip 2; OpenCode 2.0.30 passes 15, skips 4. See the dated report for
 * the initial OpenCode v1 installation timeout and unchanged retry.
 * Observed 2026-10-18: Antigravity 1.4.1 passes 15, skips 4 (account usage,
 * catalog-dependent effort enumeration, and the two unsupported steer cases).
 * Observed 2026-10-23: Kimi 2.3.1 passes 15, skips 4; OpenCode 1.19.4 and
 * 2.1.4 pass 17 and 15 after unchanged rechecks. Initial startup failures
 * are retained in runtime-version-checks/2026-10-23.md.
 */
import assert from "node:assert/strict";
import { trialCases } from "../sea-trial/cases/suite.js";
import { runSuite } from "../sea-trial/harness/runner.js";
import { runtimeUnderTest } from "../sea-trial/harness/subject.js";
import { acpBackend } from "../sea-trial/harness/acp-backends.js";
import { openTrace } from "../sea-trial/harness/trace.js";

const [id] = process.argv.slice(2);
assert.ok(id === "antigravity" || id === "grok" || id === "kimi" || id === "opencode", "Choose antigravity, grok, kimi or opencode");
const name = `${id}-aimock`;
const { runtime, aimock: env } = await acpBackend(id);
try {
  console.log(`trace: ${openTrace(name)}`);
  const outcomes = await runSuite(trialCases, runtimeUnderTest(runtime, env.env));
  process.stdout.write(`${JSON.stringify(outcomes, null, 2)}\n`);
  process.exitCode = outcomes.some(o => o.kind === "fail") ? 1 : 0;
} finally { await env.stop(); }
