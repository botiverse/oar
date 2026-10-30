/* oxlint-disable eslint/max-statements -- Each regression retains the complete ownership timeline. */
import { afterEach, expect, test, vi } from "vitest";
import { sessionCredentialRedactor } from "../../packages/oar/src/shared/credential-redactor.js";
import { AcpProtocolError } from "../../packages/oar/src/shared/acp/protocol-error.js";
import { createAcpRouting, type AcpUnattributed } from "../../packages/oar/src/shared/acp/routing.js";
import { sharedAcpWire } from "../../packages/oar/src/shared/acp/shared-wire.js";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
function fixture(maxFrames = 256) {
  const diagnostics: AcpUnattributed[] = []; const delivered: string[] = [];
  const router = createAcpRouting<string>({ diagnostic: entry => { diagnostics.push(entry); }, maxFrames,
    associations: (_method, params) => typeof params.parent === "string" && typeof params.child === "string" ? [{ parent: params.parent, child: params.child }] : [] });
  const owner = router.attach("a", sessionCredentialRedactor({}));
  const notify = (sessionId: string, text: string, link?: readonly [string, string]): void => {
    const params = { sessionId, text, parent: link?.[0], child: link?.[1] }; router.ingress(params);
    router.notify("lineage", params, () => { delivered.push(text); });
  };
  return { router, owner, diagnostics, delivered, notify };
}

test("resume rejects older descendants including host requests and queued SDK dispatch after later lineage", async () => {
  const f = fixture();
  f.notify("child", "old-child"); f.notify("grandchild", "old-grandchild");
  const host = expect(f.router.request("terminal/create", { sessionId: "grandchild" })).rejects.toThrow();
  const queued = { sessionId: "grandchild", text: "old-sdk-queue" }; f.router.ingress(queued);
  f.owner.reserve("root");
  f.notify("root", "child-link", ["root", "child"]); f.notify("root", "grandchild-link", ["child", "grandchild"]);
  await host;
  f.router.notify("session/update", queued, () => { throw new Error("old descendant reached new controller"); });
  f.notify("grandchild", "fresh-grandchild");
  expect(f.delivered).toEqual(["child-link", "grandchild-link", "fresh-grandchild"]);
  expect(f.diagnostics.map(entry => entry.reason)).toEqual(["pre_reservation", "pre_reservation", "pre_reservation", "pre_reservation"]); f.router.close();
});

test("delivered reverse-order lineage waits for the parent and proves grandchildren only within its carrier root", () => {
  const f = fixture(); f.owner.bind("root");
  f.notify("root", "grandchild-link-first", ["child", "grandchild"]);
  f.notify("grandchild", "grandchild-update");
  expect(f.diagnostics).toEqual([]);
  f.notify("root", "child-link-last", ["root", "child"]);
  expect(f.delivered).toEqual(["grandchild-link-first", "grandchild-update", "child-link-last"]);
  expect(f.diagnostics).toEqual([]); f.router.close();
});

test("unresolved delivered lineage shares the bounded buffer and reports real conflicts once", () => {
  const f = fixture(2); f.owner.bind("root");
  const peer = f.router.attach("b", sessionCredentialRedactor({})); peer.bind("peer");
  f.notify("root", "evicted-link", ["unknown-1", "child-1"]);
  f.notify("root", "remaining-link", ["unknown-2", "child-2"]);
  f.notify("root", "latest-link", ["unknown-3", "child-3"]);
  expect(f.diagnostics.map(entry => entry.reason)).toEqual(["capacity"]);
  f.notify("peer", "peer-claims-parent", ["peer", "unknown-2"]);
  for (let i = 0; i < 50; i += 1) { f.notify("root", "ordinary"); }
  expect(f.diagnostics.filter(entry => entry.reason === "conflict")).toHaveLength(1);
  expect(f.delivered.filter(text => text === "remaining-link")).toHaveLength(1); f.router.close();
});

test("a late new response naming a retired id cannot trigger native cleanup", () => {
  const f = fixture(); f.owner.bind("retired"); f.owner.dispose();
  const cleanup = vi.fn<(id: string) => void>(); const wire = sharedAcpWire(f.router, [], cleanup);
  wire.outgoing({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} });
  wire.outgoing({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: 1 } });
  wire.incoming({ jsonrpc: "2.0", id: 1, result: { sessionId: "retired" } });
  expect(cleanup).not.toHaveBeenCalled();
  expect(f.diagnostics.map(entry => entry.method)).toEqual(["cancelled_session_new_response", "cancelled_session_new_collision"]); f.router.close();
});

test("cancelled new tombstones expire after the opening timeout and connection close clears them", async () => {
  vi.useFakeTimers(); const f = fixture(); const cleanup = vi.fn<(id: string) => void>();
  const wire = sharedAcpWire(f.router, [], cleanup, 20);
  const cancel = (id: number): void => {
    wire.outgoing({ jsonrpc: "2.0", id, method: "session/new", params: {} });
    wire.outgoing({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: id } });
  };
  cancel(1); await vi.advanceTimersByTimeAsync(19);
  wire.incoming({ jsonrpc: "2.0", id: 1, result: { sessionId: "late-within-bound" } });
  expect(cleanup).toHaveBeenCalledWith("late-within-bound");
  cancel(2); await vi.advanceTimersByTimeAsync(20);
  wire.incoming({ jsonrpc: "2.0", id: 2, result: { sessionId: "too-late" } });
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(f.diagnostics.at(-1)?.method).toBe("unknown_response");
  cancel(3); expect(vi.getTimerCount()).toBe(1); wire.close(); expect(vi.getTimerCount()).toBe(0); f.router.close();
});

test("reserve on a closed connection or with an empty caller id is not a native protocol violation", () => {
  const f = fixture();
  expect(() => { f.owner.reserve(""); }).toThrow(Error);
  expect(() => { f.owner.reserve(""); }).not.toThrow(AcpProtocolError);
  f.router.close();
  expect(() => { f.owner.reserve("root"); }).toThrow(Error);
  expect(() => { f.owner.reserve("root"); }).not.toThrow(AcpProtocolError);
});

test("the credential union re-sorts only when a lease or a distinct credential is added", () => {
  const f = fixture(); const credentials = sessionCredentialRedactor({ env: { API_KEY: "prefix-secret" } });
  const sorting = vi.spyOn(Array.prototype, "toSorted");
  const lease = f.router.attach("secret", credentials);
  f.router.redact("prefix-secret"); const sorted = sorting.mock.calls.length;
  expect(sorted).toBeGreaterThan(0);
  for (let i = 0; i < 20; i += 1) { expect(f.router.redact("prefix-secret")).toBe("[redacted]"); }
  expect(sorting).toHaveBeenCalledTimes(sorted);
  credentials.add("prefix-secret-longer");
  expect(f.router.redact("prefix-secret-longer")).toBe("[redacted]");
  const updated = sorting.mock.calls.length;
  credentials.add("prefix-secret-longer"); lease.dispose();
  expect(f.router.redact("prefix-secret-longer")).toBe("[redacted]");
  expect(sorting).toHaveBeenCalledTimes(updated); f.router.close();
});
