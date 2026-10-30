/** Compare a later Kimi session with a new process after configuration changes. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { acpFixture } from "./acp-fixture.js";
import { directoryConfiguration, directoryRuleMarkers } from "./directory-configuration.js";
import { ProbeTiming } from "./observation.js";

export async function kimiConfigurationObservations(): Promise<JsonRecord[]> {
  const rows: JsonRecord[] = [];
  for (const scenario of ["different_directory", "closed_same_directory"] as const) {
    for (const mode of ["shared", "separate"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- Each comparison uses fresh process and configuration state.
      try { rows.push(await observe(scenario, mode)); }
      catch (error) { rows.push({ scenario, mode, observed: false, error: String(error) }); }
    }
  }
  return rows;
}

async function observe(scenario: "different_directory" | "closed_same_directory", mode: "shared" | "separate"): Promise<JsonRecord> {
  const timing = new ProbeTiming();
  const row: JsonRecord = { scenario, mode, observed: false, waits: timing.waits };
  const fixture = await acpFixture("kimi", timing);
  try {
    const [firstDirectory, secondDirectory] = fixture.cwds;
    assert.ok(firstDirectory !== undefined && secondDirectory !== undefined);
    const configuration = await directoryConfiguration({ runtime: "kimi", cwd: firstDirectory,
      home: fixture.home, kimiHome: fixture.provider.env.KIMI_CODE_HOME });
    row.installation = fixture.installation;
    await configuration.setRevision("A");
    const first = await fixture.connect();
    const a = await fixture.open(first, "A", { cwd: firstDirectory });
    await timing.measure("catalog settling before A", 3000, async () => { await delay(3000); });
    await fixture.prompt(first.child, a.id, "A_mcpfreshbefore");
    if (scenario === "closed_same_directory") {
      row.close = await fixture.request(first.child, "session/close", { sessionId: a.id });
    }
    await configuration.setRevision("B");
    const cwd = scenario === "different_directory" ? secondDirectory : firstDirectory;
    await writeFile(path.join(cwd, "AGENTS.md"), "Project configuration observation marker: OAR_DIRECTORY_RULE_B.\n", { mode: 0o600 });
    // Kimi's inspected source has file watchers. Preserve a bounded delay
    // before opening B, without treating that delay as a freshness guarantee.
    await timing.measure("configuration settling before B open", 3000, async () => { await delay(3000); });
    const connection = mode === "shared" ? first : await fixture.connect();
    const b = await fixture.open(connection, "B", { cwd });
    assert.notEqual(a.id, b.id);
    await timing.measure("catalog settling before B", 3000, async () => { await delay(3000); });
    const response = await fixture.prompt(connection.child, b.id, "B_mcpfreshafter");
    const output = JSON.stringify(fixture.seen.filter((entry) => entry.key === "B_mcpfreshafter"));
    row.newSession = { response, directoryRuleMarkers: directoryRuleMarkers(output), output };
    row.directoryConfiguration = await configuration.evidence();
    row.mcpInvocations = await fixture.mcpCalls();
    row.native = { calls: fixture.calls, events: fixture.events, normalized: fixture.seen };
    row.observed = true;
  } catch (error) { row.error = String(error); }
  finally {
    try { await fixture.stop(); } catch (error) { row.cleanupError = String(error); row.observed = false; }
  }
  return row;
}
