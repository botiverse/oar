/* oxlint-disable eslint/max-statements -- Retain each native routing timeline and its ownership assertions together. */
import { afterEach, expect, test, vi } from "vitest";
import { grokSharedAssociations, grokSharedAssociationChecks } from "../../packages/oar/src/runtimes/grok/sharing-attribution.js";
import { createAcpRouting, type AcpUnattributed } from "../../packages/oar/src/shared/acp/routing.js";
import { sessionCredentialRedactor } from "../../packages/oar/src/shared/credential-redactor.js";
import type { JsonRecord } from "../../packages/oar/src/shared/json.js";

afterEach(() => { vi.useRealTimers(); });
function fixture() {
  const diagnostics: AcpUnattributed[] = [];
  const deliveries: { owner: string; params: unknown; receivedAt: number }[] = [];
  const routing = createAcpRouting<string>({ associations: grokSharedAssociations, associationChecks: grokSharedAssociationChecks, requestWaitMs: 1000,
    diagnostic: d => { diagnostics.push(d); } });
  const a = routing.attach("A", sessionCredentialRedactor({ env: { API_KEY: "fixture-private-value" } })); a.bind("A");
  const b = routing.attach("B", sessionCredentialRedactor({ env: { API_KEY: "fixture-private-value-long-tail" } })); b.bind("B");
  const notify = (method: string, params: JsonRecord): void => {
    routing.ingress(params); routing.notify(method, params, (owner, ingress) => { deliveries.push({ owner, params, receivedAt: ingress.receivedAt }); });
  };
  const spawn = (carrier: string, parent: string, child: string): void => { notify("_x.ai/session_notification", { sessionId: carrier,
    update: { sessionUpdate: "subagent_spawned", parent_session_id: parent, child_session_id: child } }); };
  const completed = (parent: string, child: string): void => { notify("session/update", { sessionId: parent,
    update: { sessionUpdate: "tool_call_update", status: "completed", rawOutput: { type: "SubagentCompleted", subagent_id: child, output: "fixture-private-value-long-tail" } } }); };
  return { routing, a, b, diagnostics, deliveries, notify, spawn, completed };
}

test("child frames and permission/terminal requests wait for spawn within 1 s, preserving original time and owner", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000); const f = fixture();
  f.notify("session/update", { sessionId: "child", text: "early" });
  const permission = f.routing.request("session/request_permission", { sessionId: "child" });
  const terminal = f.routing.request("terminal/create", { sessionId: "child" });
  await vi.advanceTimersByTimeAsync(999);
  expect(f.deliveries).toEqual([]); expect(f.diagnostics).toEqual([]);
  f.spawn("A", "A", "child");
  expect(f.deliveries[0]).toMatchObject({ owner: "A", params: { text: "early" }, receivedAt: 1000 });
  const permissionOwner = await permission; const terminalOwner = await terminal;
  expect(permissionOwner.target).toBe("A"); expect(terminalOwner.target).toBe("A");
  await vi.advanceTimersByTimeAsync(6000); f.completed("A", "child"); expect(f.diagnostics).toEqual([]);
  f.routing.close();
});

test("expired child traffic never reappears, and host requests fail without invoking any owner", async () => {
  vi.useFakeTimers(); const f = fixture();
  f.notify("session/update", { sessionId: "child", text: "expired" });
  const permission = expect(f.routing.request("session/request_permission", { sessionId: "child" })).rejects.toThrow("no active native session owner");
  await vi.advanceTimersByTimeAsync(1000); await permission;
  f.spawn("A", "A", "child");
  expect(f.deliveries).toHaveLength(1); expect(f.diagnostics.map(d => d.reason)).toEqual(["expired", "expired"]);
  f.routing.close();
});

test("completed output checks accepted ancestry but cannot create, steal or reassign a child", () => {
  const f = fixture(); f.spawn("A", "A", "child");
  f.completed("A", "child"); expect(f.diagnostics).toEqual([]);
  f.completed("B", "child"); f.completed("A", "unknown");
  f.notify("session/update", { sessionId: "child", text: "still-A" });
  f.notify("session/update", { sessionId: "unknown", text: "still-unowned" });
  expect(f.deliveries.at(-1)).toMatchObject({ owner: "A", params: { text: "still-A" } });
  expect(f.routing.inUse("unknown")).toBe(false);
  expect(f.diagnostics.map(d => d.reason)).toEqual(["conflict", "conflict"]);
  expect(JSON.stringify(f.diagnostics)).not.toContain("long-tail");
  expect(JSON.stringify(f.diagnostics)).toContain("[redacted]");
  f.routing.close();
});

test("connection ownership and consistency evidence never cross pools, or accept another root's spawn", () => {
  const first = fixture(); const second = fixture(); first.spawn("A", "A", "child");
  second.completed("A", "child"); expect(second.diagnostics).toMatchObject([{ reason: "conflict" }]);
  first.spawn("A", "B", "foreign"); expect(first.routing.inUse("foreign")).toBe(false);
  first.spawn("B", "B", "foreign"); first.completed("A", "foreign");
  expect(first.diagnostics.map(d => d.reason)).toEqual(["conflict", "conflict"]);
  first.routing.close(); second.routing.close();
});

test("closed connection diagnoses waiting child frames and rejects permissions, without a 1 s wait", async () => {
  const f = fixture(); f.notify("session/update", { sessionId: "child" });
  const rejected = expect(f.routing.request("session/request_permission", { sessionId: "child" })).rejects.toThrow();
  f.routing.close(); await rejected;
  expect(f.deliveries).toEqual([]); expect(f.diagnostics.map(d => d.reason)).toEqual(["connection_closed", "connection_closed"]);
});

test("connection-wide session lists and terminal requests cannot fabricate Grok ancestry", () => {
  const f = fixture();
  f.notify("_x.ai/sessions/changed", { sessions: [{ sessionId: "child", parent_session_id: "A" }] });
  f.notify("session/update", { sessionId: "child", update: { sessionUpdate: "subagent_spawned", parent_session_id: "A", child_session_id: "other" } });
  expect(f.routing.inUse("child")).toBe(false); expect(f.routing.inUse("other")).toBe(false);
  expect(f.deliveries).toEqual([]); expect(f.diagnostics[0]?.reason).toBe("unowned"); f.routing.close();
});


test("Grok host-request deadline does not pause behind an unrelated opening session", async () => {
  vi.useFakeTimers(); const f = fixture(); f.routing.newStarted(10);
  f.notify("session/update", { sessionId: "child", text: "early" });
  const denied = expect(f.routing.request("terminal/create", { sessionId: "child" })).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(500); f.routing.newStarted(11);
  await vi.advanceTimersByTimeAsync(500); await denied;
  expect(f.diagnostics).toMatchObject([{ method: "terminal/create", reason: "expired" }]);
  f.routing.newFinished(10); f.routing.newFinished(11); f.spawn("A", "A", "child");
  expect(f.deliveries[0]).toMatchObject({ owner: "A", params: { text: "early" } }); f.routing.close();
});


test("host-request association budget uses elapsed time even if the wall clock changes before dispatch", async () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000); const f = fixture();
  const params = { sessionId: "child" }; f.routing.ingress(params, "host-clock");
  vi.setSystemTime(1000);
  const denied = expect(f.routing.request("session/request_permission", params, "host-clock")).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(1000); await denied;
  expect(f.diagnostics).toMatchObject([{ reason: "expired", receivedAt: 100_000 }]); f.routing.close();
});
