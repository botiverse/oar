import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { opencodeRuntime, type AvailableInstallation, type SessionOptions } from "../../packages/oar/src/index.js";
import { acpBackend } from "../../sea-trial/harness/acp-backends.js";

// Only fixed diagnostic categories leave the probe. Native stderr can contain configuration.
const symptoms = {
  readiness: /Standalone server exited before reporting readiness/u,
  expectedEffort: /effort not found: oar-no-such-effort/u,
  dbBusy: /SQLITE_BUSY|database is (?:locked|busy)/iu,
  dbLocked: /SQLITE_LOCKED/iu,
  dbOpen: /SQLITE_CANTOPEN|unable to open database file/iu,
  dbIO: /SQLITE_IOERR|disk I\/O error/iu,
  dbProtocol: /SQLITE_PROTOCOL|locking protocol/iu,
  permission: /\b(?:EPERM|EACCES)\b|access is denied/iu,
  missingFile: /\bENOENT\b|the system cannot find/iu,
  sharingViolation: /sharing violation|being used by another process|\bEBUSY\b/iu,
  bind: /\b(?:EADDRINUSE|WSAEADDRINUSE)\b|address already in use/iu,
  pipe: /\bEPIPE\b|broken pipe/iu,
  memory: /out of memory|allocation failed/iu,
  runtimePanic: /panic|segmentation fault|access violation/iu,
};
function classify(error: unknown): string[] {
  const message = error instanceof Error ? error.message : String(error);
  return Object.entries(symptoms).filter(([, pattern]) => pattern.test(message)).map(([key]) => key);
}
async function openAtEffort(installation: AvailableInstallation, options: SessionOptions): Promise<string[]> {
  try {
    const session = await opencodeRuntime.session(installation, { ...options, effort: "oar-no-such-effort" });
    await session.dispose();
    return ["unexpectedlyOpened"];
  } catch (error) { return classify(error); }
}
type Fixture = Awaited<ReturnType<typeof acpBackend>>;
type Mode = "serial" | "shared-directory" | "separate-directory";
function forFixture(fixture: Fixture): SessionOptions {
  return { cwd: process.cwd(), env: { ...fixture.aimock.env, OPENCODE_PRINT_LOGS: "1" } };
}
interface Control { readonly installation: AvailableInstallation; readonly first: Fixture; readonly second: Fixture }
async function sample({ installation, first, second }: Control, mode: Mode, round: number): Promise<boolean> {
  const time = Date.now();
  let stage = "first open";
  try {
    const session = await opencodeRuntime.session(installation, forFixture(first));
    try {
      stage = "prompt";
      const prompt = await session.prompt("slow diagnostic");
      assert.equal(prompt.response.body.kind, "accepted");
      stage = "dispose and open";
      const disposal = session.dispose();
      // In the failed release run the second open started 266 ms after disposal began.
      await (mode === "serial" ? disposal : delay(260));
      const testing = openAtEffort(installation, forFixture(mode === "separate-directory" ? second : first));
      const [signals] = await Promise.all([testing, disposal]);
      process.stdout.write(`${JSON.stringify({ round, mode, time, elapsed: Date.now() - time, signals })}\n`);
      return signals.includes("expectedEffort");
    } finally { await session.dispose(); }
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ round, mode, time, elapsed: Date.now() - time, stage, signals: classify(error) })}\n`);
    return false;
  }
}
const rounds = Number(process.argv[2] ?? 5);
async function compare(control: Control): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    for (const mode of ["serial", "shared-directory", "separate-directory"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- overlap only the two operations inside a sample.
      const ok = await sample(control, mode, round);
      if (!ok) { process.exitCode = 1; }
    }
  }
}
const first = await acpBackend("opencode");
try {
  const second = await acpBackend("opencode");
  try {
    const installation = await opencodeRuntime.installation();
    assert.ok(installation.kind === "available" && installation.via === "executable" && installation.version?.includes("2.2.7") === true);
    await first.beforeSuite?.(installation);
    await second.beforeSuite?.(installation);
    await compare({ installation, first, second });
  } finally { await second.aimock.stop(); }
} finally { await first.aimock.stop(); }
