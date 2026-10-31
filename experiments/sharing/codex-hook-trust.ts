/** Compare per-session hook trust in both directions, including the earlier session. */
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { codexFixture } from "./codex-fixture.js";
import { compareDirectoryConfiguration, directoryConfiguration, directoryRuleMarkers } from "./directory-configuration.js";
import { hookInputMatches } from "./directory-hooks.js";
import { preservingProbeEvidence, probeErrorText, usingProbeFixture } from "./fixture-lifetime.js";
import { invocationEvidence } from "./mcp-scope.js";
import { ProbeTiming } from "./observation.js";

export const trustScenarios = ["untrusted_then_trusted", "trusted_then_untrusted"] as const;
const inputs = ["A_mcpbefore", "B_mcpafter", "A_mcpafter"] as const;
const turnsOf = (row: JsonRecord): JsonRecord[] => Array.isArray(row.turns) ? row.turns.map(asRecord).filter((turn) => turn !== null) : [];

/** Empty hooks establish denial only after an actual tool call and a trusted-peer control. */
export function assertCodexHookTrustEvidence(row: JsonRecord): void {
  assert.equal(typeof row.aBypassHookTrust, "boolean");
  assert.equal(typeof row.bBypassHookTrust, "boolean");
  assert.notEqual(row.aBypassHookTrust, row.bBypassHookTrust);
  const turns = turnsOf(row); assert.equal(turns.length, inputs.length, "missing evidence: all three trust-control turns must finish");
  for (const input of inputs) {
    const matches = turns.filter((turn) => turn.input === input); assert.equal(matches.length, 1);
    const [turn] = matches; assert.ok(turn);
    assert.equal(asRecord(turn.invocation)?.isolated, true, `${input}: actual MCP invocation required`);
    assert.equal(turn.nativeOutputRetained, true, `${input}: native result must retain the actual MCP output`);
    const hooks = turn.hookRevisions; assert.ok(Array.isArray(hooks), `${input}: hook journal required`);
    const trusted = input.startsWith("A_") ? row.aBypassHookTrust : row.bBypassHookTrust;
    assert.equal(hooks.length > 0, trusted, `${input}: hooks must follow this session's own trust parameter`);
  }
}

export function compareCodexHookTrust(shared: JsonRecord, separate: JsonRecord): JsonRecord {
  const configuration = compareDirectoryConfiguration(shared, separate);
  const revisions = (row: JsonRecord): unknown[] => inputs.map((input) => turnsOf(row).find((turn) => turn.input === input)?.hookRevisions);
  const verified = [shared, separate].every((row) => {
    try { assertCodexHookTrustEvidence(row); return row.observed === true; }
    catch { return false; }
  });
  // An expected empty journal is meaningful here only after the three native
  // invocation checks and a positive trusted-session hook check passed.
  const hookRevisionsMatch = verified
    ? JSON.stringify(revisions(shared)) === JSON.stringify(revisions(separate)) : null;
  const missingEvidence = configuration.projectMarkersMatch === null || hookRevisionsMatch === null;
  return { ...configuration, scenario: shared.scenario, hookRevisionsMatch, missingEvidence,
    passed: configuration.projectMarkersMatch === true && hookRevisionsMatch === true,
    differenceObserved: configuration.projectMarkersMatch === false || hookRevisionsMatch === false,
    limitation: "Compares B's instruction markers and all three exercised hook outcomes; empty hooks count only for a verified untrusted session, with a positive trusted-peer control." };
}

export async function codexHookTrustObservations(): Promise<JsonRecord[]> {
  const rows: JsonRecord[] = [];
  for (const scenario of trustScenarios) {
    for (const mode of ["shared", "separate"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- Stop each fresh fixture before constructing the next control.
      rows.push(await observeTrust(scenario, mode));
    }
  }
  return rows;
}

async function observeTrust(scenario: (typeof trustScenarios)[number], mode: "shared" | "separate"): Promise<JsonRecord> {
  const timing = new ProbeTiming();
  const aTrust = scenario === "trusted_then_untrusted"; const bTrust = !aTrust;
  const row: JsonRecord = { scenario, mode, observed: false, waits: timing.waits, aBypassHookTrust: aTrust, bBypassHookTrust: bTrust,
    scope: "Opposite per-session bypass_hook_trust values, including A after B opens; persisted trust-store changes are not exercised" };
  try {
    await usingProbeFixture(async () => { const fixture = await codexFixture(timing); return fixture; }, async (fixture) => {
      const [cwd] = fixture.cwds; assert.ok(cwd !== undefined);
      const configuration = await directoryConfiguration({ runtime: "codex", cwd, home: fixture.home, env: fixture.provider.env });
      const turns: JsonRecord[] = []; row.turns = turns;
      const invoke = async (connection: Awaited<ReturnType<typeof fixture.connect>>, id: string, input: (typeof inputs)[number]): Promise<void> => {
        const response = await fixture.turn(connection, id, input);
        const output = JSON.stringify(fixture.seen.filter((entry) => entry.key === input));
        const turn = { input, response, output, directoryRuleMarkers: directoryRuleMarkers(output) }; turns.push(turn);
        if (input === "B_mcpafter") { row.newSession = turn; }
      };
      await preservingProbeEvidence(async () => {
        await configuration.setRevision("A");
        const first = await fixture.connect();
        const a = await fixture.open(first, "A", { cwd, bypassHookTrust: aTrust });
        await timing.measure("catalog settling before A", 3000, async () => { await delay(3000); });
        await invoke(first, a, "A_mcpbefore");
        await configuration.setRevision("B");
        const connection = mode === "shared" ? first : await fixture.connect();
        const b = await fixture.open(connection, "B", { cwd, bypassHookTrust: bTrust });
        await timing.measure("catalog settling before B", 3000, async () => { await delay(3000); });
        await invoke(connection, b, "B_mcpafter");
        await invoke(first, a, "A_mcpafter");
      }, [
        async (): Promise<void> => { row.directoryConfiguration = await configuration.evidence(); },
        async (): Promise<void> => {
          const calls = await fixture.mcpCalls(); row.mcpInvocations = calls;
          for (const turn of turns) {
            const input = String(turn.input);
            const invocation = invocationEvidence(calls, input, input.startsWith("A_") ? "A" : "B");
            turn.invocation = invocation;
            const { output } = turn;
            turn.nativeOutputRetained = typeof output === "string" && invocation.calls.length === 1
              && invocation.calls.every((call) => output.includes(call.output));
          }
        },
        (): void => { row.native = { calls: fixture.calls, events: fixture.events, normalized: fixture.seen }; },
        (): void => {
          const hooks = asRecord(row.directoryConfiguration)?.hooks; assert.ok(Array.isArray(hooks));
          for (const turn of turns) {
            turn.hookRevisions = hooks.filter((hook: unknown) => hookInputMatches(asRecord(hook)?.event, String(turn.input)))
              .map((hook: unknown) => asRecord(hook)?.revision);
          }
          assertCodexHookTrustEvidence(row);
        },
      ]);
      row.observed = true;
    });
  } catch (error) { row.error = probeErrorText(error); row.observed = false; }
  return row;
}
