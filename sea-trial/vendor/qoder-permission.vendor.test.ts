/* oxlint-disable import/max-dependencies -- Native permission stimulus and the production transport and response policy. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { launchQoder } from "../../packages/oar/src/runtimes/qoder/launch.js";
import { qoderControl } from "../../packages/oar/src/runtimes/qoder/control.js";
import { qoderPermissionResponse } from "../../packages/oar/src/runtimes/qoder/permission.js";
import { asRecord, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { qoderFixture } from "./support/qoder-fixture.js";

test.skipIf(process.env.OAR_TEST !== "qoder-native")("native permission request crosses stdio and the production reply unlocks execution", async () => {
  const fixture = await qoderFixture([{ tool: { name: "Bash", args: { command: "echo granted > permission-marker" } } }, { text: "permission completed" }]);
  const id = randomUUID();
  const child = await launchQoder(process.env.OAR_QODER_BIN ?? "qodercli", id, fixture.options);
  const control = qoderControl(child, () => {});
  const requests: JsonRecord[] = [];
  const replies: JsonRecord[] = [];
  const result = Promise.withResolvers<JsonRecord>();
  const marker = path.join(fixture.options.cwd, "permission-marker");
  child.onLine((line) => {
    const frame = asRecord(parseJson(line));
    if (frame === null || control.consume(frame)) { return; }
    const request = asRecord(frame.request);
    if (frame.type === "control_request" && request?.subtype === "can_use_tool" && typeof frame.request_id === "string") {
      requests.push(frame);
      assert.equal(existsSync(marker), false, "the tool must remain blocked until its permission response");
      const response = qoderPermissionResponse(frame.request_id, request);
      replies.push(response); child.write(`${JSON.stringify(response)}\n`);
    }
    if (frame.type === "result") { result.resolve(frame); }
  });
  child.onExit(control.end);
  const timer = setTimeout(() => { result.reject(new Error("Native Qoder permission roundtrip timed out")); }, 45_000);
  try {
    await control.request({ subtype: "initialize" });
    // Stimulus only: normal OAR sessions use bypass_permissions. Ask mode
    // forces a real native request through the unchanged OAR transport/policy.
    await control.request({ type: "set_permission_mode", mode: "default" });
    child.write(`${JSON.stringify({ type: "user", session_id: id, uuid: randomUUID(), message: { role: "user", content: "exercise permission" } })}\n`);
    const ended = await result.promise;
    expect(ended.subtype).toBe("success");
    expect(requests).toHaveLength(1);
    expect(replies).toHaveLength(1);
    expect(asRecord(replies[0]?.response)?.request_id).toBe(requests[0]?.request_id);
    expect(asRecord(asRecord(replies[0]?.response)?.response)?.behavior).toBe("allow");
    expect(await readFile(marker, "utf8")).toMatch(/granted/u);
  } finally { clearTimeout(timer); control.end(); child.kill(); await child.exited; }
}, 90_000);
