/**
 * Compare serial/concurrent native opens with identical inline settings and
 * with a settings file per fixture. No prompt, real login or model call.
 * Run: OAR_QODER_BIN=/path/to/qodercli pnpm tsx experiments/qoder-native/inline-settings.ts
 * An intermittent race need not reproduce in every batch; keep every result.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { qoderControl } from "../../packages/oar/src/runtimes/qoder/control.js";
import { closeQoder, launchQoder } from "../../packages/oar/src/runtimes/qoder/launch.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";
import { startQoderNative } from "../../sea-trial/harness/qoder-native.js";

const inline = JSON.stringify({ security: { auth: { useExternal: true } } });
const sharedTemp = await mkdtemp(path.join(tmpdir(), "qoder-inline-settings-"));
const count = 12;

async function open(mode: "inline" | "file", index: number): Promise<boolean> {
  const fixture = await startQoderNative([]);
  let child: Awaited<ReturnType<typeof launchQoder>> | undefined = undefined;
  const started = performance.now();
  try {
    const args = [...fixture.options.launchArgs ?? []];
    if (mode === "inline") { args[1] = inline; }
    child = await launchQoder(process.env.OAR_QODER_BIN ?? "qodercli", randomUUID(), {
      ...fixture.options,
      // Keep the native hash-named files in a disposable shared directory.
      env: { ...fixture.options.env, TMPDIR: sharedTemp, TMP: sharedTemp, TEMP: sharedTemp },
      launchArgs: args,
    });
    const control = qoderControl(child, () => {}, 60_000);
    child.onLine((line) => {
      const frame = asRecord(parseJson(line));
      if (frame !== null) { control.consume(frame); }
    });
    child.onExit(control.end);
    await control.request({ subtype: "initialize" });
    process.stdout.write(`${JSON.stringify({ mode, index, initialized: true, elapsedMs: performance.now() - started })}\n`);
    return true;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ mode, index, initialized: false, elapsedMs: performance.now() - started,
      error: error instanceof Error ? error.message : String(error) })}\n`);
    return false;
  } finally {
    try { if (child !== undefined) { await closeQoder(child); } }
    finally { await fixture.stop(); }
  }
}

try {
  const serial: boolean[] = [];
  for (let index = 0; index < count; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    serial.push(await open("inline", index));
  }
  for (const mode of ["inline", "file"] as const) {
    // eslint-disable-next-line no-await-in-loop
    const results = await Promise.all(Array.from({ length: count }, async (_, index) => { const result = await open(mode, index); return result; }));
    process.stdout.write(`${JSON.stringify({ group: `concurrent-${mode}`, passed: results.filter(Boolean).length, total: count })}\n`);
    if (mode === "file" && results.some((passed) => !passed)) { process.exitCode = 1; }
  }
  process.stdout.write(`${JSON.stringify({ group: "serial-inline", passed: serial.filter(Boolean).length, total: count })}\n`);
  if (serial.some((passed) => !passed)) { process.exitCode = 1; }
} finally { await rm(sharedTemp, { recursive: true, force: true }); }
