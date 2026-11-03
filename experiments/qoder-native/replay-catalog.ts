/**
 * Compare the native model readback in Qoder's synthetic replay fixture.
 * Run: pnpm tsx experiments/qoder-native/replay-catalog.ts /absolute/qodercli VERSION
 * No real login or model provider; only selected model fields leave the fixture.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { qoderSession } from "../../packages/oar/src/runtimes/qoder/session.js";
import { qoderControl, qoderInitializeTimeoutMs } from "../../packages/oar/src/runtimes/qoder/control.js";
import { closeQoder, launchQoder } from "../../packages/oar/src/runtimes/qoder/launch.js";
import { asRecord, asRecordList, parseJson } from "../../packages/oar/src/shared/json.js";
import { startQoderNative } from "../../sea-trial/harness/qoder-native.js";

const [command, version] = process.argv.slice(2);
assert.ok(command !== undefined && path.isAbsolute(command) && version !== undefined);
const fixture = await startQoderNative([{ text: "synthetic response" }]);
const options = { ...fixture.options, model: "efficient" };
const rows: unknown[] = [];
try {
  const child = await launchQoder(command, randomUUID(), options, version);
  const control = qoderControl(child, () => {});
  let initModel: string | null = null;
  child.onLine(line => {
    const frame = asRecord(parseJson(line));
    if (frame === null) { return; }
    if (frame.type === "system" && frame.subtype === "init" && typeof frame.model === "string") { initModel = frame.model; }
    control.consume(frame);
  });
  child.onExit(control.end);
  try {
    await control.request({ subtype: "initialize" }, qoderInitializeTimeoutMs);
    for (const fetchStrategy of ["cache", "live"]) {
      // eslint-disable-next-line no-await-in-loop
      const answer = await control.request({ subtype: "get_models", fetchStrategy });
      const models = asRecordList(asRecord(asRecord(answer.response)?.response)?.models);
      const selected = models.find(model => model.value === options.model);
      rows.push({ fetchStrategy, initModel, selected: selected === undefined ? null : {
        keys: Object.keys(selected).toSorted(), value: selected.value,
        displayName: selected.displayName,
        nativeName: asRecord(selected.serverModel)?.display_name ?? null,
      } });
    }
  } finally { control.end(); await closeQoder(child); }
  let opened: unknown = null;
  try {
    const session = await qoderSession({ kind: "available", via: "executable", command, version }, options);
    try { opened = { kind: "opened", model: session.model().value }; }
    finally { await session.dispose(); }
  } catch (error) {
    opened = { kind: "refused", reason: error instanceof Error ? error.message : String(error) };
  }
  console.log(JSON.stringify({ version, syntheticReplay: true, requested: options.model, rows, opened }, null, 2));
} finally { await fixture.stop(); }
