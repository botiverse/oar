import { expect, test, vi } from "vitest";
import { qoderSession } from "../../packages/oar/src/runtimes/qoder/session.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess } from "../fixtures/fake-line-process.js";

const launch = vi.hoisted(() => ({ launchQoder: vi.fn(), closeQoder: vi.fn() }));
vi.mock("../../packages/oar/src/runtimes/qoder/launch.js", () => launch);

const privateData = { email: "private@example.invalid", username: "private-user", org_id: "private-org", access_token: "fixture-private-token" };
function privateControlProcess() {
  const child = fakeLineProcess((line, process) => {
    const request = asRecord(parseJson(line));
    if (asRecord(request?.request)?.subtype === "initialize") {
      process.emit(`${JSON.stringify({ type: "system", subtype: "init", model: "efficient" })}\n`);
    }
    const payload = asRecord(request?.request)?.subtype === "get_settings"
      ? { sources: { user: privateData }, effective: privateData, applied: { effort: "high", ...privateData } } : privateData;
    process.emit(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: request?.request_id, response: payload } })}\n`);
  });
  launch.launchQoder.mockResolvedValue(child);
  launch.closeQoder.mockImplementation(async () => { child.end(0); await child.exited; });
  return child;
}
function expectPrivateDataAbsent(records: string) {
  for (const value of Object.values(privateData)) { expect(records).not.toContain(value); }
  expect(records).not.toContain('"email"');
  expect(records).not.toContain('"org_id"');
}

test("private initialize and settings, including repeated responses, never expose account or configuration", async () => {
  const child = privateControlProcess();
  const session = await qoderSession({ kind: "available", via: "executable", command: "fixture", version: "1.1.78" }, { cwd: "/work", model: "efficient", effort: "high" });
  try {
    const initialize = asRecord(parseJson(child.written[0] ?? ""));
    child.emit(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: initialize?.request_id, response: privateData } })}\n`);
    expect(session.effort().value).toBe("high");
    expectPrivateDataAbsent(JSON.stringify(session.records()));
    expect(session.status().value.kind).toBe("idle");
  } finally { await session.dispose(); }
});
