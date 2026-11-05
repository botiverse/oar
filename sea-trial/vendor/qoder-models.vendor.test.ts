/* oxlint-disable import/max-dependencies -- Compare native catalog and init frames with the public adapter in an isolated home. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { qoderInstallation } from "../../packages/oar/src/runtimes/qoder/installation.js";
import { launchQoder, closeQoder } from "../../packages/oar/src/runtimes/qoder/launch.js";
import { qoderControl, qoderInitializeTimeoutMs } from "../../packages/oar/src/runtimes/qoder/control.js";
import { projectQoderModels } from "../../packages/oar/src/runtimes/qoder/list-models.js";
import { qoderSession } from "../../packages/oar/src/runtimes/qoder/session.js";
import { qoderVersionInfo } from "../../packages/oar/src/runtimes/qoder/protocol.js";
import { asRecord, asRecordList, parseJson } from "../../packages/oar/src/shared/json.js";
import { qoderFixture } from "./support/qoder-fixture.js";

test.skipIf(process.env.OAR_TEST !== "qoder-native")("native model catalog identifies the selected model without submitting a prompt", async () => {
  const fixture = await qoderFixture([]);
  const installation = await qoderInstallation();
  assert.ok(installation.kind === "available" && installation.via === "executable");
  const options = { ...fixture.options, model: "efficient" };
  // Omit installation.version to exercise the same native version probe that
  // chooses both --sdk and the model confirmation path.
  const child = await launchQoder(installation.command, randomUUID(), options);
  const control = qoderControl(child, () => {});
  let initModel: unknown = undefined;
  let expected: unknown = undefined;
  child.onLine(line => {
    const frame = asRecord(parseJson(line));
    if (frame === null) { return; }
    if (frame.type === "system" && frame.subtype === "init") { initModel = frame.model; }
    control.consume(frame);
  });
  child.onExit(control.end);
  try {
    await control.request({ subtype: "initialize" }, qoderInitializeTimeoutMs);
    const answer = await control.request({ subtype: "get_models", fetchStrategy: "live" });
    const payload = asRecord(asRecord(answer.response)?.response);
    const rows = asRecordList(payload?.models);
    const selected = rows.find(row => row.value === options.model);
    assert.ok(selected, "native catalog must contain efficient");
    if (qoderVersionInfo(child.qoderVersion).modelFormat === "server") {
      expected = asRecord(selected.serverModel)?.display_name;
    } else {
      // These are assertions on actual daemon.get_models fields, independently
      // of OAR's projection and model-confirmation helper.
      expect(selected.modelId).toBe(options.model);
      expect(rows.filter(row => row.displayName === selected.displayName)).toHaveLength(1);
      expected = selected.displayName;
    }
    assert.ok(typeof expected === "string" && expected.length > 0);
    expect(initModel).toBe(expected);
    expect(projectQoderModels(payload, child.qoderVersion).find(model => model.id === options.model)?.resolvedId).toBe(expected);
  } finally { control.end(); await closeQoder(child); }
  const session = await qoderSession({ kind: "available", via: "executable", command: installation.command }, options);
  try {
    expect(session.model().value).toBe(expected);
    expect(session.status().value.kind).toBe("idle");
    expect(session.records().flatMap(record => record.kind === "frame" ? record.body.events.filter(event => event.kind === "turn_active" || event.kind === "user_message") : [])).toEqual([]);
  } finally { await session.dispose(); }
}, 90_000);
