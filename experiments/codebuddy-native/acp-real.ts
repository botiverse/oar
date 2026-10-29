import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { codebuddyRuntime } from "../../packages/oar/src/runtimes/codebuddy/index.js";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import type { Session } from "../../packages/oar/src/contracts/session.js";

/** Run on the computer holding the native login. Three short real turns;
 * no login attempt, account identity, raw records or error details are exported. */
const { values } = parseArgs({ options: { binary: { type: "string" }, output: { type: "string" } } });
if (values.binary !== undefined) { process.env.OAR_CODEBUDDY_BIN = path.resolve(values.binary); }
const report: Record<string, unknown> = {
  probe: "codebuddy-acp-real-2026-10-29", platform: process.platform, arch: process.arch,
  startedAt: new Date().toISOString(),
};
const cwd = await mkdtemp(path.join(tmpdir(), "oar-codebuddy-acp-real-"));
let session: Session | null = null;
let stage = "installation";
try {
  const installation = await codebuddyRuntime.installation();
  if (installation.kind !== "available" || installation.via !== "executable") { throw new Error("unavailable"); }
  report.version = installation.version;
  stage = "authStatus";
  const status = await codebuddyRuntime.authStatus(installation);
  report.authStatus = status.kind;
  if (status.kind !== "logged_in") { throw new Error("not logged in"); }
  stage = "open";
  session = await codebuddyRuntime.session(installation, { cwd });
  report.capabilities = session.capabilities;
  const turns: unknown[] = [];
  report.turns = turns;
  for (const marker of ["OAR_CODEBUDDY_FIRST", "OAR_CODEBUDDY_SECOND"]) {
    stage = marker;
    // oxlint-disable-next-line eslint/no-await-in-loop -- The probe verifies serialized consecutive turns.
    const run = await promptAndWait(session, `Reply with exactly ${marker}. Do not use tools.`, { timeoutMs: 60_000 });
    turns.push({ marker, kind: run.kind, ...(run.kind === "ended" ? { outcome: run.outcome.kind, expectedText: run.text.trim() === marker } : {}) });
    if (run.kind !== "ended" || run.outcome.kind !== "completed" || run.text.trim() !== marker) { throw new Error("turn failed"); }
  }
  const { id } = session;
  await session.dispose();
  stage = "resume";
  session = await codebuddyRuntime.session(installation, { cwd, resume: id });
  report.sameSessionId = session.id === id;
  const run = await promptAndWait(session, "Reply with exactly OAR_CODEBUDDY_RESUMED. Do not use tools.", { timeoutMs: 60_000 });
  report.resumed = { kind: run.kind, ...(run.kind === "ended" ? { outcome: run.outcome.kind } : {}) };
  report.tokenUsage = session.usage().value;
  report.contextUsage = session.contextUsage().value;
  report.pass = report.sameSessionId === true && run.kind === "ended" && run.outcome.kind === "completed" && run.text.trim() === "OAR_CODEBUDDY_RESUMED";
} catch (error) {
  report.pass = false;
  report.failedStage = stage;
  report.errorKind = error instanceof Error ? error.name : "Error";
} finally {
  await session?.dispose();
  await rm(cwd, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  const output = values.output ?? `codebuddy-acp-real-${Date.now()}.json`;
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(`${report.pass === true ? "PASS" : "NOT_VERIFIED"}: ${output}`);
}
