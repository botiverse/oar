/* oxlint-disable import/max-dependencies -- Native experiment composes fixtures and independent evidence sources. */
/** Native trust grants and later sessions in another canonical directory. */
import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { acpFixture, type AcpFixture } from "./acp-fixture.js";
import { directoryConfiguration, directoryRuleMarkers } from "./directory-configuration.js";
import { freshnessCohortFailures } from "./configuration-freshness-checks.js";
import { providerRequestsFor } from "./directory-hooks.js";
import { preservingProbeEvidence, probeErrorText, usingProbeFixture } from "./fixture-lifetime.js";
import { invocationEvidence } from "./mcp-scope.js";
import { ProbeTiming } from "./observation.js";

async function trustStore(file: string): Promise<string | null> {
  try { return await readFile(file, "utf8"); }
  catch (error) { if (asRecord(error)?.code === "ENOENT") { return null; } throw error; }
}

async function grantTrust(fixture: AcpFixture, cwd: string): Promise<JsonRecord> {
  assert.equal(fixture.id, "grok");
  const grokHome = fixture.provider.env.GROK_HOME; assert.ok(grokHome !== undefined);
  const file = path.join(grokHome, "trusted_folders.toml");
  const before = await trustStore(file);
  // This separate native CLI is the user action; the observed process remains
  // alive throughout. Never synthesize the trust file or disable folder trust.
  const grant = await fixture.connect({ cwd, grantGrokTrust: true });
  const after = await trustStore(file);
  grant.child.kill();
  const exited = await fixture.timing.wait(grant.child.exited, "native trust grant shutdown");
  return { method: ["grok", ...grant.args].join(" "), cwd, initialized: true, exited,
    storeBefore: before, storeAfter: after, storeChanged: before !== after,
    trustedEntryPresent: after !== null && /^trusted = true$/mu.test(after) };
}

export async function observeConfigurationFreshness(runtime: "grok" | "opencode", scenario: string, mode: "shared" | "separate"): Promise<JsonRecord> {
  const timing = new ProbeTiming();
  const row: JsonRecord = { runtime, scenario, mode, observed: false, waits: timing.waits, trustGrants: [], turns: [] };
  const turns: JsonRecord[] = []; row.turns = turns;
  const grants: JsonRecord[] = []; row.trustGrants = grants;
  try {
    await usingProbeFixture(async () => { const fixture = await acpFixture(runtime, timing); return fixture; }, async (fixture) => {
      const [cwdA, other] = fixture.cwds; assert.ok(cwdA !== undefined && other !== undefined);
      const cwdB = scenario === "native_trust_grant" ? cwdA : other;
      const canonical = await Promise.all([cwdA, cwdB].map(async (cwd) => { const value = await realpath(cwd); return process.platform === "win32" ? value.toLowerCase() : value; }));
      row.distinctCanonicalDirectories = canonical[0] !== canonical[1];
      const configuration = await directoryConfiguration({ runtime, cwd: cwdA, home: fixture.home, env: fixture.provider.env,
        grokTrust: "default", grokHookScope: scenario === "different_directory_user_hooks" ? "user" : "project",
        opencodeConfigurationScope: scenario === "different_directory_user_configuration" ? "user" : "project" });
      row.installation = fixture.installation;
      const invoke = async (connection: Awaited<ReturnType<AcpFixture["connect"]>>, id: string, input: string): Promise<void> => {
        const response = await fixture.prompt(connection.child, id, input);
        const output = JSON.stringify(providerRequestsFor(fixture.provider.raw, input));
        const invocation = invocationEvidence(await fixture.mcpCalls(), input, input.startsWith("A_") ? "A" : "B");
        const nativeOutputRetained = invocation.calls.length === 1 && output.includes(invocation.calls[0]?.output ?? "");
        turns.push({ input, response, output, invocation, nativeOutputRetained, directoryRuleMarkers: directoryRuleMarkers(output) });
      };
      await preservingProbeEvidence(async () => {
        await configuration.setRevision("A");
        if (runtime === "grok" && scenario !== "native_trust_grant") { grants.push(await grantTrust(fixture, cwdA)); }
        const first = await fixture.connect();
        const a = await fixture.open(first, "A", { cwd: cwdA });
        await timing.measure("catalog settling before A", 3000, async () => { await delay(3000); });
        await invoke(first, a.id, "A_mcpfreshbefore");
        await configuration.setRevision("B", cwdB);
        if (runtime === "grok") {
          const aliveBefore = !first.child.closed;
          grants.push(await grantTrust(fixture, cwdB));
          row.observedProcessAliveDuringGrant = aliveBefore && !first.child.closed;
        }
        // Equal settling in shared and fresh controls, with A still alive.
        await timing.measure("configuration settling before B", 3000, async () => { await delay(3000); });
        const next = mode === "shared" ? first : await fixture.connect();
        const b = await fixture.open(next, "B", { cwd: cwdB }); assert.notEqual(a.id, b.id);
        await timing.measure("catalog settling before B", 3000, async () => { await delay(3000); });
        await invoke(next, b.id, "B_mcpfreshafter");
        await invoke(first, a.id, "A_mcpfreshlater");
      }, [
        async (): Promise<void> => { row.directoryConfiguration = await configuration.evidence(); },
        async (): Promise<void> => {
          const calls = await fixture.mcpCalls(); row.mcpInvocations = calls;
          for (const turn of turns) {
            const input = String(turn.input);
            turn.finalInvocation = invocationEvidence(calls, input, input.startsWith("A_") ? "A" : "B");
          }
        },
        (): void => { row.native = { calls: fixture.calls, events: fixture.events, normalized: fixture.seen }; },
        (): void => { const failures = freshnessCohortFailures(row); row.failureReasons = failures; assert.equal(failures.length, 0, failures.join("; ")); },
      ]);
      row.observed = true;
    });
  } catch (error) { row.error = probeErrorText(error); row.observed = false; }
  return row;
}
