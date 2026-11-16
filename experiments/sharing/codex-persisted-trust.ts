/** Persisted native hook grants and revocations, compared with separate processes. */
/* oxlint-disable import/max-dependencies -- This manual native probe owns transport, fixture cleanup and evidence. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { prepareWindowsProcessTable } from "../../sea-trial/windows-process-table.js";
import { codexFixture, type CodexFixture } from "./codex-fixture.js";
import { directoryConfiguration } from "./directory-configuration.js";
import { hookInputMatches } from "./directory-hooks.js";
import { preservingProbeEvidence, probeErrorText, usingProbeFixture } from "./fixture-lifetime.js";
import { hookExecutionFailures, nativeHookCompletions } from "./hook-completions.js";
import { invocationEvidence } from "./mcp-scope.js";
import { ProbeTiming } from "./observation.js";
import { recordProcessTableReads } from "./process-table.js";

type Connection = Awaited<ReturnType<CodexFixture["connect"]>>;
const out = path.resolve(process.argv[2] ?? "oar-trial-run/codex-persisted-trust");
await mkdir(out, { recursive: true });
recordProcessTableReads(path.join(out, "process-table-reads.jsonl"));
prepareWindowsProcessTable(path.join(out, "windows-process-table-preparation.jsonl"));
const rows: JsonRecord[] = [];
const report = { at: new Date().toISOString(), platform: process.platform, architecture: process.arch,
  scope: "Synthetic CODEX_HOME only, no bypass_hook_trust; one writer versus explicit reload of each process", cohorts: rows };

function hookRows(result: JsonRecord): JsonRecord[] {
  assert.ok(Array.isArray(result.data));
  return result.data.flatMap((entry: unknown) => {
    const hooks = asRecord(entry)?.hooks; assert.ok(Array.isArray(hooks));
    return hooks.map((hook: unknown) => { const row = asRecord(hook); assert.ok(row); return row; });
  });
}

async function writeTrust(fixture: CodexFixture, connection: Connection, { hook, trusted }: { hook: JsonRecord; trusted: boolean }): Promise<JsonRecord> {
  assert.equal(typeof hook.key, "string"); assert.equal(typeof hook.currentHash, "string");
  const value = trusted ? { [String(hook.key)]: { trusted_hash: hook.currentHash } } : {};
  const reply = await fixture.request(connection, "config/batchWrite", {
    edits: [{ keyPath: "hooks.state", value, mergeStrategy: "replace" }], reloadUserConfig: true,
  });
  const configHome = fixture.provider.env?.CODEX_HOME; assert.ok(configHome !== undefined);
  const persisted = await readFile(path.join(configHome, "config.toml"), "utf8");
  assert.equal(persisted.includes(String(hook.currentHash)), trusted, "native write must change persisted hook trust");
  return { trusted, reply, persistedHashPresent: persisted.includes(String(hook.currentHash)) };
}

async function observe(mode: "shared" | "separate"): Promise<void> {
  const timing = new ProbeTiming();
  const turns: JsonRecord[] = []; const mutations: JsonRecord[] = [];
  const row: JsonRecord = { mode, observed: false, waits: timing.waits, turns, mutations };
  rows.push(row);
  await usingProbeFixture(async () => { const fixture = await codexFixture(timing); return fixture; }, async (fixture) => {
    row.installation = fixture.installation;
    assert.equal(fixture.installation.version, "codex-cli 0.169.0", "this admission observation is version-specific");
    const [cwd] = fixture.cwds; assert.ok(cwd !== undefined);
    const configuration = await directoryConfiguration({ runtime: "codex", cwd, home: fixture.home, env: fixture.provider.env });
    await preservingProbeEvidence(async () => {
      await configuration.setRevision("A");
      const first = await fixture.connect();
      const second = mode === "shared" ? first : await fixture.connect();
      const initial = await fixture.request(first, "hooks/list", { cwds: [cwd] });
      const [hook] = hookRows(initial); assert.ok(hook); assert.equal(hookRows(initial).length, 1);
      assert.equal(hook.trustStatus, "untrusted"); row.initialHook = hook;
      const a = await fixture.open(first, "A", { cwd });
      const b = await fixture.open(second, "B", { cwd });
      assert.notEqual(a, b);
      await timing.measure("catalog settling before trust controls", 3000, async () => { await delay(3000); });
      const invoke = async (phase: string): Promise<void> => {
        for (const [label, connection, id] of [["A", first, a], ["B", second, b]] as const) {
          const input = `${label}_mcp${phase}`;
          // oxlint-disable-next-line no-await-in-loop -- Observe the writer and peer in a fixed order without hiding a late reload.
          const listed = await fixture.request(connection, "hooks/list", { threadId: id });
          // oxlint-disable-next-line no-await-in-loop -- Every phase exercises the actual tool and records its native hook result.
          const response = await fixture.turn(connection, id, input);
          const output = JSON.stringify(fixture.seen.filter((entry) => entry.key === input));
          turns.push({ phase, input, label, response, output, hooks: hookRows(listed) });
        }
      };
      await invoke("initial");
      mutations.push({ phase: "grant", ...await writeTrust(fixture, first, { hook, trusted: true }) });
      await invoke("grant");
      // The explicit peer write is a control, not an automatic retry. It shows
      // whether the persisted state can be loaded by that process at all.
      mutations.push({ phase: "grantpeer", ...await writeTrust(fixture, second, { hook, trusted: true }) });
      await invoke("grantpeer");
      mutations.push({ phase: "revoke", ...await writeTrust(fixture, first, { hook, trusted: false }) });
      await invoke("revoke");
      mutations.push({ phase: "revokepeer", ...await writeTrust(fixture, second, { hook, trusted: false }) });
      await invoke("revokepeer");
    }, [
      async (): Promise<void> => {
        const evidence = await configuration.evidence();
        // This probe never installs the bypass described by the shared helper.
        evidence.trustCondition = "Native config/batchWrite persists hooks.state, reloadUserConfig=true; no bypass override";
        row.directoryConfiguration = evidence;
      },
      async (): Promise<void> => {
        const calls = await fixture.mcpCalls(); row.mcpInvocations = calls;
        const hooks = asRecord(row.directoryConfiguration)?.hooks; assert.ok(Array.isArray(hooks));
        for (const turn of turns) {
          const input = String(turn.input);
          turn.invocation = invocationEvidence(calls, input, turn.label === "A" ? "A" : "B");
          turn.hookRevisions = hooks.filter((entry: unknown) => hookInputMatches(asRecord(entry)?.event, input))
            .map((entry: unknown) => asRecord(entry)?.revision);
        }
      },
      (): void => {
        row.native = { calls: fixture.calls, events: fixture.events, normalized: fixture.seen };
        row.nativeHookCompletions = nativeHookCompletions(row.native);
        row.processIdentities = fixture.processIdentities;
      },
    ]);
    assert.equal(turns.length, 10);
    assert.deepEqual(hookExecutionFailures(row, "persisted trust"), []);
    for (const turn of turns) {
      assert.equal(asRecord(turn.response)?.status, "completed");
      const invocation = asRecord(turn.invocation); assert.equal(invocation?.isolated, true);
      const { calls } = invocation; assert.ok(Array.isArray(calls) && calls.length === 1);
      const nativeOutput = asRecord(calls[0])?.output;
      assert.ok(String(turn.output).includes(String(nativeOutput)), "actual MCP output must reach the provider");
      assert.ok(Array.isArray(turn.hookRevisions));
      if (["initial", "revokepeer"].includes(String(turn.phase))) { assert.equal(turn.hookRevisions.length, 0); }
      if (turn.phase === "grantpeer") { assert.ok(turn.hookRevisions.length > 0, "positive trusted control required"); }
      const trusted = turn.phase === "grantpeer" || (turn.phase === "grant" && (mode === "shared" || turn.label === "A"))
        || (turn.phase === "revoke" && mode === "separate" && turn.label === "B");
      assert.equal(turn.hookRevisions.length > 0, trusted, `${mode} ${String(turn.input)}: process-scoped reload changed`);
    }
    row.observed = true;
  });
}

for (const mode of ["shared", "separate"] as const) {
  // oxlint-disable-next-line no-await-in-loop -- Compare fresh controls after each native cohort has stopped.
  try { await observe(mode); }
  catch (error) { const row = rows.at(-1); assert.ok(row); row.error = probeErrorText(error); row.observed = false; }
  // oxlint-disable-next-line no-await-in-loop -- Keep every failed or successful observation before starting the next one.
  await writeFile(path.join(out, "evidence.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}
const outcome = (row: JsonRecord): unknown[] => Array.isArray(row.turns) ? row.turns.map((entry: unknown) => {
  const turn = asRecord(entry); return { phase: turn?.phase, label: turn?.label, hookRevisions: turn?.hookRevisions };
}) : [];
const comparison = { observed: rows.every((row) => row.observed === true),
  sameHookOutcomes: JSON.stringify(outcome(rows[0] ?? {})) === JSON.stringify(outcome(rows[1] ?? {})),
  classification: "Declared difference: user-level trust reload reaches all loaded threads in the receiving process; other processes need their own reload",
  admission: "This timing difference is documented, not an equivalence pass or an admission failure" };
await writeFile(path.join(out, "evidence.json"), `${JSON.stringify({ ...report, comparison }, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ comparison, cohorts: rows.map((row) => ({ mode: row.mode, observed: row.observed, error: row.error, turns: outcome(row) })) }, null, 2)}\n`);
assert.equal(comparison.observed, true, "incomplete native controls; inspect evidence.json");
