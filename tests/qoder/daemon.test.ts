/* oxlint-disable eslint/max-statements -- Sequential transport roundtrip and cleanup assertions. */
import assert from "node:assert/strict";
import { afterEach, expect, test, vi } from "vitest";
import { qoderDaemonSession } from "../../packages/oar/src/runtimes/qoder/daemon.js";
import { qoderDaemonAuth, qoderProtocol } from "../../packages/oar/src/runtimes/qoder/protocol.js";
import { asRecord, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess } from "../fixtures/fake-line-process.js";

afterEach(() => { vi.useRealTimers(); });
const capabilities = ["multi_session_v2", "daemon_queries_v1"];
function lastWrite(child: ReturnType<typeof fakeLineProcess>): JsonRecord | null { return asRecord(parseJson(child.written.at(-1) ?? "")); }
function daemon(options: { capabilities?: string[]; openedId?: string; rejection?: string; silent?: boolean } = {}) {
  return fakeLineProcess((text, child) => {
    const frame = asRecord(parseJson(text));
    const request = asRecord(frame?.request);
    if (options.silent === true || typeof request?.type !== "string") { return; }
    const initialized = request.type === "daemon.initialize";
    child.emit(`${JSON.stringify({ type: "control_response", ...(initialized || request.type === "daemon.get_models" ? {} : { session_id: options.openedId ?? "s1" }),
      response: { request_id: frame?.request_id, subtype: options.rejection === undefined ? "success" : "error",
        ...(options.rejection === undefined ? { response: initialized ? { daemon_protocol_version: 2, capabilities: options.capabilities ?? capabilities, account: "private identity" } : { models: [] } } : { error: options.rejection }) } })}\n`);
  });
}

test.each(["1.1.78", "1.1.79", "1.1.80"])("preserves the legacy worker protocol for %s", (version) => { expect(qoderProtocol(version)).toBe("worker"); });
test.each(["1.1.81", "1.1.82", "1.2.0", "2.0.0"])("uses the explicit daemon handshake for %s", (version) => { expect(qoderProtocol(version)).toBe("daemon"); });
test.each([undefined, "", "unknown", "1.1.81-preview", "1.1"])("an unreadable stable version refuses to guess: %s", (version) => { expect(() => qoderProtocol(version)).toThrow("version compatibility could not be determined"); });

test("daemon handshake and catalog controls stay private; native session frames keep their identity", async () => {
  const child = daemon();
  const process = await qoderDaemonSession(child, "s1", ["--session-id", "s1", "--permission-prompt-tool", "stdio"], "/work", {});
  const seen: JsonRecord[] = [];
  process.onLine((line) => { const frame = asRecord(parseJson(line)); assert.ok(frame); seen.push(frame); });
  expect(seen).toEqual([]);
  expect(child.written.map((line) => { const frame = asRecord(parseJson(line)); assert.ok(frame); const { request_id: _id, ...rest } = frame; return rest; })).toEqual([
    { type: "control_request", request: { type: "daemon.initialize", daemon_protocol_version: 2, sdk_version: "oar", capabilities, auth: { type: "qodercli" } } },
    { type: "control_request", request: { type: "daemon.open_session", worker_args: ["--session-id", "s1", "--permission-prompt-tool", "stdio"], cwd: "/work" } },
  ]);
  process.write(`${JSON.stringify({ type: "control_request", request_id: "models", request: { subtype: "get_models", fetchStrategy: "cache" } })}\n`);
  expect(lastWrite(child)).toEqual({ type: "control_request", request_id: "models", request: { type: "daemon.get_models", fetchStrategy: "cache" } });
  expect(seen).toEqual([{ type: "control_response", response: { request_id: "models", subtype: "success", response: { models: [] } } }]);
  const permission = { type: "control_request", request_id: "permission", session_id: "s1", request: { subtype: "can_use_tool", input: { command: "fixture" } } };
  child.emit(`${JSON.stringify(permission)}\n`);
  expect(seen.at(-1)).toEqual(permission);
  const response = { type: "control_response", response: { request_id: "permission", subtype: "success", response: { behavior: "allow" } } };
  process.write(`${JSON.stringify(response)}\n`);
  expect(lastWrite(child)).toEqual({ ...response, session_id: "s1" });
  process.write(`${JSON.stringify({ type: "control_request", request_id: "abort", request: { subtype: "interrupt" } })}\n`);
  expect(lastWrite(child)?.session_id).toBe("s1");
  expect(JSON.stringify(seen)).not.toContain("private identity");
  process.stdin.end();
  expect(child.stdin.writableEnded).toBe(true);
  process.kill();
  expect(child.killed()).toBe(true);
  await process.exited;
});

test.each([{ capabilities: ["multi_session_v2"] }, { capabilities: ["daemon_queries_v1"] }, { openedId: "wrong" }, { rejection: "secret-token identity@example.invalid" }])("incompatible or refused daemon startup kills the owned process: %j", async (options) => {
  const child = daemon(options);
  const failure = await qoderDaemonSession(child, "s1", [], "/work", {}).catch((error: unknown) => error);
  assert.ok(failure instanceof Error);
  expect(failure.message).not.toContain("secret-token");
  expect(failure.message).not.toContain("identity@example.invalid");
  expect(child.killed()).toBe(true);
  await child.exited;
});

test("silent daemon initialization is bounded and cleans up", async () => {
  vi.useFakeTimers();
  const child = daemon({ silent: true });
  const failure = expect(qoderDaemonSession(child, "s1", [], "/work", {})).rejects.toThrow("daemon.initialize within 60000 ms");
  await vi.advanceTimersByTimeAsync(60_000);
  await failure;
  expect(child.killed()).toBe(true);
});

test("process death rejects a pending handshake immediately", async () => {
  const child = daemon({ silent: true });
  const failure = expect(qoderDaemonSession(child, "s1", [], "/work", {})).rejects.toThrow("exited before answering");
  child.end(1); await failure;
});

test("foreign session input is refused and foreign output stops the dedicated daemon", async () => {
  const child = daemon();
  const process = await qoderDaemonSession(child, "s1", [], "/work", {});
  expect(() => { process.write('{"type":"user","session_id":"wrong"}\n'); }).toThrow("does not belong");
  child.emit('{"type":"assistant","session_id":"wrong"}\n');
  expect(child.killed()).toBe(true);
  expect(process.diagnostics().error?.code).toBe("QODER_PROTOCOL_ERROR");
  expect(process.diagnostics().error?.message).toContain("frame belonging to another session");
});

test("a foreign startup frame refuses opening with the protocol reason", async () => {
  const child = daemon({ openedId: "foreign" });
  await expect(qoderDaemonSession(child, "s1", [], "/work", {})).rejects.toThrow("frame belonging to another session");
  expect(child.killed()).toBe(true);
});

test("authentication selection preserves explicit child environment credentials", () => {
  expect(qoderDaemonAuth({})).toEqual({ type: "qodercli" });
  expect(qoderDaemonAuth({ QODER_PERSONAL_ACCESS_TOKEN: "pat" })).toEqual({ type: "accessToken", accessToken: "pat" });
  expect(qoderDaemonAuth({ QODER_SERVICE_ACCOUNT_KEY: "service" })).toEqual({ type: "serviceAccount", serviceAccountKey: "service" });
  expect(() => qoderDaemonAuth({ QODER_SERVICE_ACCOUNT_KEY: "service", QODER_PERSONAL_ACCESS_TOKEN: "pat" })).toThrow("cannot be combined");
  expect(() => qoderDaemonAuth({ QODER_JOB_TOKEN: "private" })).toThrow("host callback");
});
