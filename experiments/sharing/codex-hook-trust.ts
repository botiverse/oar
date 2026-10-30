/** Compare a later per-session hook-trust override with a fresh process. */
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { codexFixture } from "./codex-fixture.js";
import { directoryConfiguration, directoryRuleMarkers } from "./directory-configuration.js";
import { hookInputMatches } from "./directory-hooks.js";
import { preservingProbeEvidence, probeErrorText, usingProbeFixture } from "./fixture-lifetime.js";
import { invocationEvidence } from "./mcp-scope.js";
import { ProbeTiming } from "./observation.js";

export async function codexHookTrustObservations(): Promise<JsonRecord[]> {
  const rows: JsonRecord[] = [];
  for (const mode of ["shared", "separate"] as const) {
    const timing = new ProbeTiming();
    const row: JsonRecord = { mode, observed: false, waits: timing.waits, aBypassHookTrust: false, bBypassHookTrust: true,
      scope: "Per-session bypass_hook_trust false for A, true only when opening B; persisted trust-store changes are not exercised" };
    rows.push(row);
    try {
      // oxlint-disable-next-line no-await-in-loop -- Stop each fresh fixture before constructing the control.
      await usingProbeFixture(async () => { const fixture = await codexFixture(timing); return fixture; }, async (fixture) => {
        const [cwd] = fixture.cwds; assert.ok(cwd !== undefined);
        const configuration = await directoryConfiguration({ runtime: "codex", cwd, home: fixture.home, env: fixture.provider.env });
        await preservingProbeEvidence(async () => {
          await configuration.setRevision("A");
          const first = await fixture.connect();
          const a = await fixture.open(first, "A", { cwd, bypassHookTrust: false });
          await timing.measure("catalog settling before A", 3000, async () => { await delay(3000); });
          await fixture.turn(first, a, "A_mcpbefore");
          await configuration.setRevision("B");
          const connection = mode === "shared" ? first : await fixture.connect();
          const b = await fixture.open(connection, "B", { cwd, bypassHookTrust: true });
          await timing.measure("catalog settling before B", 3000, async () => { await delay(3000); });
          const response = await fixture.turn(connection, b, "B_mcpafter");
          const output = JSON.stringify(fixture.seen.filter((entry) => entry.key === "B_mcpafter"));
          row.newSession = { response, output, directoryRuleMarkers: directoryRuleMarkers(output) };
        }, [
          async (): Promise<void> => { row.directoryConfiguration = await configuration.evidence(); },
          async (): Promise<void> => {
            const calls = await fixture.mcpCalls(); row.mcpInvocations = calls;
            row.aInvocation = invocationEvidence(calls, "A_mcpbefore", "A");
            const bInvocation = invocationEvidence(calls, "B_mcpafter", "B"); row.bInvocation = bInvocation;
            const output = asRecord(row.newSession)?.output;
            row.bNativeOutputRetained = typeof output === "string" && bInvocation.calls.length === 1
              && bInvocation.calls.every((call) => output.includes(call.output));
          },
          (): void => { row.native = { calls: fixture.calls, events: fixture.events, normalized: fixture.seen }; },
          (): void => {
            const hooks = asRecord(row.directoryConfiguration)?.hooks;
            assert.ok(Array.isArray(hooks));
            row.aHookObserved = hooks.some((hook: unknown) => hookInputMatches(asRecord(hook)?.event, "A_mcpbefore"));
            row.bHookObserved = hooks.some((hook: unknown) => hookInputMatches(asRecord(hook)?.event, "B_mcpafter"));
            assert.equal(row.aHookObserved, false, "A must establish the untrusted-hook baseline");
            assert.equal(row.bHookObserved, true, "missing evidence: B must invoke its newly trusted hook");
            assert.equal(asRecord(row.aInvocation)?.isolated, true);
            assert.equal(asRecord(row.bInvocation)?.isolated, true);
            assert.equal(row.bNativeOutputRetained, true, "B's native result must retain its actual MCP output");
          },
        ]);
        row.observed = true;
      });
    } catch (error) { row.error = probeErrorText(error); row.observed = false; }
  }
  return rows;
}
