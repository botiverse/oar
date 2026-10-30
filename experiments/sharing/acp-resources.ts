/** Shared versus isolated ACP, same executable/environment, no account traffic.
 * pnpm tsx experiments/sharing/acp-resources.ts <runtime> [output-dir] [count]
 */
/* oxlint-disable eslint/no-await-in-loop -- Serial cohorts prevent resource contention between measurements. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { checkedProcessTable } from "./process-table.js";
import { acpFixture, acpId } from "./acp-fixture.js";
import { resourceSample, rootsSince } from "./resources.js";
import { ProbeTiming, prepareFixture } from "./observation.js";

const id = acpId(process.argv[2] ?? "kimi");
const out = path.resolve(process.argv[3] ?? `oar-trial-run/${id}-sharing-resources`);
const count = Number(process.argv[4] ?? 10); assert.ok(count > 0 && count <= 26);
await mkdir(out, { recursive: true });
const reports: Record<string, unknown>[] = [];
for (const mode of ["isolated", "shared"]) {
  const timing = new ProbeTiming();
  const report: Record<string, unknown> = { mode, count, at: new Date().toISOString(), platform: process.platform, waits: timing.waits };
  const fixture = await prepareFixture(out, report, async () => { const value = await acpFixture(id, timing); return value; }); report.installation = fixture.installation;
  try {
    const before = checkedProcessTable();
    const first = await fixture.connect(); const sessions = [];
    for (let index = 0; index < count; index += 1) {
      const connection = index === 0 || mode === "shared" ? first : await fixture.connect();
      sessions.push({ connection, session: await fixture.open(connection, index % 2 === 0 ? "A" : "B", false) });
    }
    const roots = rootsSince(before); assert.equal(roots.length, mode === "shared" ? 1 : count);
    report.opened = await resourceSample(roots);
    await Promise.all(sessions.map(async ({ connection, session }) => { await fixture.prompt(connection.child, session.id, `${session.label}_resource`); }));
    await delay(5000); const windows = [];
    for (let i = 0; i < 3; i += 1) { windows.push(await resourceSample(roots)); }
    report.afterTurn = windows; report.outcome = "completed";
  } catch (error) { report.outcome = "failed"; report.error = String(error); }
  finally { await fixture.stop(); }
  reports.push(report);
  await writeFile(path.join(out, "evidence.json"), `${JSON.stringify(reports, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
assert.ok(reports.every((report) => report.outcome === "completed"));
