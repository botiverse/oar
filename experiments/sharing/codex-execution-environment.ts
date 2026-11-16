/** Same process environment, distinct session directories, actual native children. */
/* oxlint-disable import/max-dependencies, no-await-in-loop -- Sequential native cohorts retain every observation before fixture cleanup. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { prepareWindowsProcessTable } from "../../sea-trial/windows-process-table.js";
import { codexFixture, type CodexFixture } from "./codex-fixture.js";
import { directoryConfiguration } from "./directory-configuration.js";
import { preservingProbeEvidence, probeErrorText, usingProbeFixture } from "./fixture-lifetime.js";
import { hookExecutionFailures, nativeHookCompletions } from "./hook-completions.js";
import { invocationEvidence } from "./mcp-scope.js";
import { ProbeTiming, cwdEvidence } from "./observation.js";
import { recordProcessTableReads } from "./process-table.js";

const marker = "OAR_CODEX_SAME_PROCESS_ENVIRONMENT";
const out = path.resolve(process.argv[2] ?? "oar-trial-run/codex-execution-environment");
await mkdir(out, { recursive: true });
recordProcessTableReads(path.join(out, "process-table-reads.jsonl"));
prepareWindowsProcessTable(path.join(out, "windows-process-table-preparation.jsonl"));
const cohorts: JsonRecord[] = [];
const report = { at: new Date().toISOString(), platform: process.platform, architecture: process.arch,
  scope: "Identical launch environment in both placements; not per-thread credential isolation", cohorts };

function toolOutput(fixture: CodexFixture, input: string): string {
  return fixture.seen.filter((entry) => entry.key === input).flatMap((entry) => {
    const messages = asRecord(entry.request)?.messages; assert.ok(Array.isArray(messages));
    const values: readonly unknown[] = messages;
    return values.filter((message) => asRecord(message)?.role === "tool");
  }).map((message: unknown) => { const content = asRecord(message)?.content; return typeof content === "string" ? content : JSON.stringify(content); }).join("\n");
}

for (const mode of ["shared", "separate"] as const) {
  const timing = new ProbeTiming();
  const row: JsonRecord = { mode, observed: false, waits: timing.waits, expectedEnvironmentMarker: marker };
  cohorts.push(row);
  try {
    await usingProbeFixture(async () => { const fixture = await codexFixture(timing, marker); return fixture; }, async (fixture) => {
      row.installation = fixture.installation;
      assert.equal(fixture.installation.version, "codex-cli 0.169.0");
      const [cwd] = fixture.cwds; assert.ok(cwd !== undefined);
      const configuration = await directoryConfiguration({ runtime: "codex", cwd, home: fixture.home, env: fixture.provider.env });
      await preservingProbeEvidence(async () => {
        await configuration.setRevision("A");
        const first = await fixture.connect(); const second = mode === "shared" ? first : await fixture.connect();
        const a = await fixture.open(first, "A", { bypassHookTrust: true });
        const b = await fixture.open(second, "B", { bypassHookTrust: true });
        const turns: JsonRecord[] = []; row.turns = turns;
        for (const [label, client, id, directory] of [["A", first, a, fixture.cwds[0]], ["B", second, b, fixture.cwds[1]]] as const) {
          assert.ok(directory !== undefined);
          for (const phase of ["cwd", "mcpbaseline"] as const) {
            const input = `${label}_${phase}`;
            const response = await fixture.turn(client, id, input);
            const output = toolOutput(fixture, input);
            const turn: JsonRecord = { input, label, response, output }; turns.push(turn);
            assert.equal(response.status, "completed");
            if (phase === "cwd") {
              turn.directory = cwdEvidence(directory, output);
              assert.ok(output.includes(`ENV_RESULT=${marker}`), `${input}: missing actual tool environment marker`);
              turn.environmentMarker = marker;
            } else {
              const invocation = invocationEvidence(await fixture.mcpCalls(), input, label); turn.invocation = invocation;
              assert.equal(invocation.isolated, true); assert.ok(output.includes(invocation.calls[0]?.output ?? "missing MCP output"));
            }
          }
        }
      }, [
        async (): Promise<void> => { row.mcpStarts = await fixture.mcpStarts(); row.directoryConfiguration = await configuration.evidence(); },
        (): void => { row.native = { calls: fixture.calls, events: fixture.events, normalized: fixture.seen };
          row.nativeHookCompletions = nativeHookCompletions(row.native); },
      ]);
      assert.ok(Array.isArray(row.mcpStarts) && row.mcpStarts.length === 2);
      row.mcpChildren = row.mcpStarts.map((entry: unknown) => {
        const start = asRecord(entry); assert.ok(start && (start.server === "A" || start.server === "B") && typeof start.cwd === "string");
        assert.equal(start.environmentMarker, marker);
        const expected = fixture.cwds[start.server === "A" ? 0 : 1]; assert.ok(expected !== undefined);
        return { label: start.server, environmentMarker: start.environmentMarker, directory: cwdEvidence(expected, `CWD_RESULT=${start.cwd}`) };
      });
      const hooks = asRecord(row.directoryConfiguration)?.hooks; assert.ok(Array.isArray(hooks) && hooks.length === 4);
      row.hookChildren = hooks.map((entry: unknown) => {
        const hook = asRecord(entry); const event = asRecord(hook?.event);
        const input = typeof event?.tool_use_id === "string" ? event.tool_use_id.replace(/^tool-/u, "") : "";
        assert.ok(/^[AB]_(?:cwd|mcpbaseline)$/u.test(input));
        assert.equal(hook?.environmentMarker, marker); assert.equal(typeof hook.cwd, "string");
        const expected = fixture.cwds[input.startsWith("A_") ? 0 : 1]; assert.ok(expected !== undefined);
        return { input, environmentMarker: hook.environmentMarker, directory: cwdEvidence(expected, `CWD_RESULT=${String(hook.cwd)}`) };
      });
      assert.deepEqual(hookExecutionFailures(row, "child environment"), []);
      row.observed = true;
    });
  } catch (error) { row.observed = false; row.error = probeErrorText(error); }
  await writeFile(path.join(out, "evidence.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}
const passed = cohorts.length === 2 && cohorts.every((row) => row.observed === true);
await writeFile(path.join(out, "evidence.json"), `${JSON.stringify({ ...report, passed }, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ passed, cohorts: cohorts.map((row) => ({ mode: row.mode, observed: row.observed, error: row.error })) }));
assert.equal(passed, true, "native child cwd/environment comparison incomplete; evidence retained");
