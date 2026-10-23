/* oxlint-disable eslint/max-statements, import/max-dependencies -- Temporary diagnostic preserves the native startup sequence and cleanup in one script. */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { qoderInstallation } from "../packages/oar/src/runtimes/qoder/installation.js";
import { launchQoder, closeQoder } from "../packages/oar/src/runtimes/qoder/launch.js";
import { qoderControl } from "../packages/oar/src/runtimes/qoder/control.js";
import { asRecord } from "../packages/oar/src/shared/json.js";
import { startQoderNative } from "../sea-trial/harness/qoder-native.js";

const started = performance.now();
const report: Record<string, unknown>[] = [];
function note(value: Record<string, unknown>): void {
  const entry = { ms: Math.round(performance.now() - started), ...value };
  report.push(entry);
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

try {
  note({ phase: "installation", platform: process.platform, node: process.version });
  const installation = await qoderInstallation();
  note({ phase: "installation-result", kind: installation.kind });
  if (installation.kind !== "available" || installation.via !== "executable") {
    throw new Error("Qoder installation unavailable");
  }
  const fixture = await startQoderNative([{ text: "startup-probe" }]);
  try {
    const child = await launchQoder(installation.command, randomUUID(), { ...fixture.options, model: "efficient" });
    const control = qoderControl(child, () => {});
    child.onLine((line) => {
      try {
        const message = asRecord(JSON.parse(line));
        if (message === null) { note({ phase: "stdout", json: "non-object" }); return; }
        // Only protocol tags are retained; initialize and settings contain private data.
        note({ phase: "stdout", type: message.type, subtype: message.subtype, response: asRecord(message.response)?.subtype });
        control.consume(message);
      } catch { note({ phase: "stdout", json: false, bytes: line.length }); }
    });
    child.onExit((code) => { note({ phase: "exit", code }); control.end(); });
    try {
      note({ phase: "initialize-sent" });
      await control.request({ subtype: "initialize" });
      note({ phase: "initialize-answered" });
      await control.request({ subtype: "get_settings" });
      note({ phase: "settings-answered" });
    } finally {
      note({ phase: "diagnostics", ...child.diagnostics() });
      control.end();
      await closeQoder(child);
    }
  } finally { await fixture.stop(); }
} catch (error) {
  note({ phase: "failed", message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  await mkdir("oar-trial-run", { recursive: true });
  await writeFile("oar-trial-run/qoder-startup-summary.json", JSON.stringify(report, null, 2));
}
