/** Repeated same-version/platform comparisons. Local provider; no account traffic.
 * OAR_CODEX_BIN=/absolute/codex pnpm tsx experiments/sharing/codex-resources.ts [output-dir] [count]
 */
/* oxlint-disable eslint/no-await-in-loop -- Serial cohorts and idle windows avoid measuring competing probes. */
import assert from "node:assert/strict";
import { prepareWindowsProcessTable } from "../../sea-trial/windows-process-table.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { checkedProcessTable } from "./process-table.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { codexFixture } from "./codex-fixture.js";
import { resourceSample, rootsSince } from "./resources.js";
import { ProbeTiming, prepareFixture } from "./observation.js";

const out = path.resolve(process.argv[2] ?? "oar-trial-run/codex-sharing-resources");
const count = Number(process.argv[3] ?? 10); assert.ok(count > 0 && count <= 26);
await mkdir(out, { recursive: true });
prepareWindowsProcessTable(path.join(out, "windows-process-table-preparation.jsonl"));
const reports: Record<string, unknown>[] = [];
for (const mode of ["isolated", "shared", "shared", "isolated"]) {
  const timing = new ProbeTiming();
  const report: Record<string, unknown> = { mode, count, at: new Date().toISOString(), platform: process.platform, waits: timing.waits };
  const fixture = await prepareFixture(out, report, async () => { const value = await codexFixture(timing); return value; }); report.installation = fixture.installation;
  try {
    const before = checkedProcessTable();
    const first = await fixture.connect();
    const sessions = [];
    for (let index = 0; index < count; index += 1) {
      const client = index === 0 || mode === "shared" ? first : await fixture.connect();
      const opened = await fixture.request(client, "thread/start", { cwd: fixture.home, model: "gpt-5.1", approvalPolicy: "never" });
      const id = asRecord(opened.thread)?.id; assert.equal(typeof id, "string");
      sessions.push({ client, id: String(id), key: `${String.fromCodePoint(65 + index)}_resource` });
    }
    const roots = rootsSince(before); assert.equal(roots.length, mode === "shared" ? 1 : count);
    report.opened = await resourceSample(roots);
    await Promise.all(sessions.map(async (session) => { await fixture.turn(session.client, session.id, session.key); }));
    await delay(5000);
    const windows = [];
    for (let i = 0; i < 3; i += 1) { windows.push(await resourceSample(roots)); }
    report.afterTurn = windows;
    report.outcome = "completed";
  } catch (error) { report.outcome = "failed"; report.error = String(error); }
  finally { await fixture.stop(); }
  reports.push(report);
  await writeFile(path.join(out, "evidence.json"), `${JSON.stringify(reports, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
assert.ok(reports.every((report) => report.outcome === "completed"));
