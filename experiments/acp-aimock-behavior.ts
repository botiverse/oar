/**
 * Shared session behavior on native ACP runtimes using a local scripted
 * provider and temporary runtime configuration, without account access.
 * Run: pnpm tsx experiments/acp-aimock-behavior.ts <grok|opencode>
 * Pin the executable with OAR_GROK_BIN or OAR_OPENCODE_BIN.
 * Account usage and standalone model catalogs deliberately stay out of
 * this subject. Their behavior cases skip; native session capabilities
 * determine the other skips. Cases and timeouts are unchanged.
 * Observed 2026-10-16: Grok 1.0.60 and OpenCode 1.19.2 pass 17 cases,
 * skip 2; OpenCode 2.0.30 passes 15, skips 4. See the dated report for
 * the initial OpenCode v1 installation timeout and unchanged retry.
 */
import assert from "node:assert/strict";
import { defineRuntime, grokInstallation, grokSession, opencodeInstallation, opencodeSession } from "../packages/oar/src/index.js";
import { trialCases } from "../sea-trial/cases/suite.js";
import { runSuite } from "../sea-trial/harness/runner.js";
import { runtimeUnderTest } from "../sea-trial/harness/subject.js";
import { startGrokAimock, startOpencodeAimock } from "../sea-trial/harness/aimock-acp.js";
import { openTrace } from "../sea-trial/harness/trace.js";

const [id] = process.argv.slice(2);
assert.ok(id === "grok" || id === "opencode", "Choose grok or opencode");
const grok = id === "grok";
const name = grok ? "grok-aimock" : "opencode-aimock";
const env = await (grok ? startGrokAimock : startOpencodeAimock)(mock => {
  mock.onMessage(/slow/u, {content: "ok"}, {latency:900});
  mock.onMessage(/^(?![\s\S]*slow)[\s\S]*$/u, {content:"ok"}, {latency:80});
});
try {
  console.log(`trace: ${openTrace(name)}`);
  const outcomes = await runSuite(trialCases, runtimeUnderTest(defineRuntime({id: name, installation: grok ? grokInstallation : opencodeInstallation, session: grok ? grokSession : opencodeSession}), env.env));
  process.stdout.write(`${JSON.stringify(outcomes, null, 2)}\n`);
  process.exitCode = outcomes.some(o => o.kind === "fail") ? 1 : 0;
} finally { await env.stop(); }
