/** Same-version daemon resource comparison, synthetic native model replies. */
/* oxlint-disable eslint/no-await-in-loop -- Cohorts and process starts are measured serially. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readProcessTable } from "../../packages/oar/src/shared/executable/process-tree.js";
import { qoderFixture } from "./qoder-fixture.js";
import { resourceSample, rootsSince } from "./resources.js";

const out = path.resolve(process.argv[2] ?? "oar-trial-run/qoder-sharing-resources");
const count = Number(process.argv[3] ?? 10); assert.ok(count > 0 && count <= 26); await mkdir(out, { recursive: true });
const reports: Record<string, unknown>[] = [];
for (const mode of ["isolated", "shared"]) {
  const fixture = await qoderFixture(); const before = readProcessTable();
  const report: Record<string, unknown> = { mode, count, at: new Date().toISOString(), platform: process.platform, installation: fixture.installation };
  try {
    const first = await fixture.connect(); const sessions = [];
    for (let index = 0; index < count; index += 1) {
      const connection = index === 0 || mode === "shared" ? first : await fixture.connect();
      sessions.push({ connection, session: await fixture.open(connection, { cwd: fixture.home, replies: [{ text: "RESOURCE_REPLY" }] }) });
    }
    const roots = rootsSince(before); assert.equal(roots.length, mode === "shared" ? 1 : count); report.opened = await resourceSample(roots);
    await Promise.all(sessions.map(async ({ connection, session }) => { const result = await fixture.turn(connection, session.id); assert.equal(result.result, "RESOURCE_REPLY"); }));
    await delay(5000); const windows = [];
    for (let index = 0; index < 3; index += 1) { windows.push(await resourceSample(roots)); }
    report.afterTurn = windows; report.outcome = "completed";
  } catch (error) { report.outcome = "failed"; report.error = String(error); }
  finally { await fixture.stop(); }
  reports.push(report); await writeFile(path.join(out, "evidence.json"), `${JSON.stringify(reports, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
assert.ok(reports.every((report) => report.outcome === "completed"));
