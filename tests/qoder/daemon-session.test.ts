import { afterEach, expect, test, vi } from "vitest";
import { qoderDaemonSession } from "../../packages/oar/src/runtimes/qoder/daemon.js";
import { qoderSession } from "../../packages/oar/src/runtimes/qoder/session.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const launch = vi.hoisted(() => ({ launchQoder: vi.fn(), closeQoder: vi.fn() }));
vi.mock("../../packages/oar/src/runtimes/qoder/launch.js", () => launch);
afterEach(() => { vi.clearAllMocks(); });
const installation = { kind: "available", via: "executable", command: "fixture", version: "1.1.81" } as const;

function daemonSessionProcesses(): FakeLineProcess[] {
  const children: FakeLineProcess[] = [];
  launch.launchQoder.mockImplementation(async (_command: string, id: string) => {
    const child = fakeLineProcess((line, process) => {
      const frame = asRecord(parseJson(line));
      const request = asRecord(frame?.request);
      const initializing = request?.type === "daemon.initialize";
      if (frame?.type !== "control_request") { return; }
      if (request?.subtype === "initialize") { process.emit(`${JSON.stringify({ type: "system", subtype: "init", session_id: id, model: "efficient" })}\n`); }
      process.emit(`${JSON.stringify({ type: "control_response", ...(initializing ? {} : { session_id: id }),
        response: { subtype: "success", request_id: frame.request_id, response: initializing
          ? { daemon_protocol_version: 2, capabilities: ["multi_session_v2", "daemon_queries_v1"] } : { applied: {} } } })}\n`);
    });
    children.push(child);
    return qoderDaemonSession(child, id, [], "/work", {});
  });
  launch.closeQoder.mockImplementation(async (child: FakeLineProcess) => { child.kill(); await child.exited; });
  return children;
}

// oxlint-disable-next-line eslint/max-statements -- Verbatim storage and continued session usability are checked in one transcript.
test.each([{}, { session_id: null }])("an unknown connection-wide daemon notification remains verbatim without ending the session: %j", async (scope) => {
  const children = daemonSessionProcesses();
  const session = await qoderSession({ ...installation, version: "1.1.81" }, { cwd: "/work" });
  try {
    const native = { type: "daemon.future_notice", ...scope, message: "future protocol addition", extra: { value: 1 } };
    children[0]?.emit(`${JSON.stringify(native)}\n`);
    expect(session.records()).toContainEqual(expect.objectContaining({ kind: "frame", body: { type: native.type, native, events: [] } }));
    expect(children[0]?.killed()).toBe(false);
    expect(session.status().value.kind).toBe("idle");
    const prompted = await session.prompt("still usable");
    expect(prompted.response.body.kind).toBe("accepted");
  } finally { await session.dispose(); }
});

// oxlint-disable-next-line eslint/max-statements -- One transcript verifies the native boundary, recorded reason and derived views.
test("a foreign session frame terminates with an OAR reason in records, events and the unfinished turn", async () => {
  const children = daemonSessionProcesses();
  const session = await qoderSession({ ...installation, version: "1.1.81" }, { cwd: "/work" });
  const events: unknown[] = [];
  session.events((event) => { events.push(event); });
  try {
    await session.prompt("pending turn");
    children[0]?.emit('{"type":"assistant","session_id":"foreign-session","message":"foreign content"}\n');
    const reason = "Qoder daemon received a frame belonging to another session; OAR terminated the owned process";
    expect(children[0]?.killed()).toBe(true);
    expect(session.records()).toContainEqual(expect.objectContaining({ kind: "response", body: { kind: "exited", code: null, reason } }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "exited", code: null, reason }));
    expect(session.status().value).toMatchObject({ kind: "idle", lastTurnOutcome: { kind: "failed", failure: "runtime_exited", reason } });
    expect(JSON.stringify(session.records())).not.toContain("foreign content");
    expect(session.records().filter((record) => record.kind === "frame" && record.body.events.some((event) => event.kind === "turn_ended"))).toEqual([]);
  } finally { await session.dispose(); }
});
