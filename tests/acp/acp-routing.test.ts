/* oxlint-disable eslint/max-statements -- Each test retains the full routing sequence and its observable assertions. */
import { afterEach, expect, test, vi } from "vitest";
import { UnsupportedOptionError } from "../../packages/oar/src/contracts/errors.js";
import { SessionUnavailableError } from "../../packages/oar/src/contracts/session-unavailable-error.js";
import { sessionCredentialRedactor } from "../../packages/oar/src/shared/credential-redactor.js";
import { sharedAcpWire } from "../../packages/oar/src/shared/acp/shared-wire.js";
import { AcpProtocolError } from "../../packages/oar/src/shared/acp/protocol-error.js";
import { createAcpRouting, type AcpUnattributed } from "../../packages/oar/src/shared/acp/routing.js";

afterEach(() => { vi.useRealTimers(); });

function fixture(limits: { maxFrames?: number; maxBytes?: number; waitMs?: number } = {}) {
  const diagnostics: AcpUnattributed[] = [];
  const delivered: { target: string; text: string; receivedAt: number }[] = [];
  const router = createAcpRouting<string>({ diagnostic: (entry) => { diagnostics.push(entry); }, ...limits,
    associations: (_method, params) => typeof params.child === "string" && typeof params.sessionId === "string"
      ? [{ parent: params.sessionId, child: params.child }] : [],
  });
  const a = router.attach("a", sessionCredentialRedactor({}));
  const b = router.attach("b", sessionCredentialRedactor({}));
  const notify = (sessionId: string, text: string, child?: string): void => {
    const params = { sessionId, text, ...(child === undefined ? {} : { child }) };
    router.ingress(params);
    router.notify("session/update", params, (target, ingress) => { delivered.push({ target, text, receivedAt: ingress.receivedAt }); });
  };
  return { router, a, b, diagnostics, delivered, notify };
}

test("interleaved opens release only the id actually bound, retaining ingress time and order", () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const f = fixture();
  f.notify("B", "b-first"); vi.setSystemTime(1100); f.notify("A", "a-first"); f.notify("B", "b-second");
  f.a.bind("A");
  expect(f.delivered).toEqual([{ target: "a", text: "a-first", receivedAt: 1100 }]);
  vi.setSystemTime(1200); f.b.bind("B");
  expect(f.delivered.slice(1)).toEqual([{ target: "b", text: "b-first", receivedAt: 1000 }, { target: "b", text: "b-second", receivedAt: 1100 }]);
  expect(f.diagnostics).toEqual([]); f.router.close();
});

test("late explicit multi-level lineage routes children and cannot steal a peer", () => {
  const f = fixture(); f.b.bind("B");
  f.notify("grandchild", "early-grandchild"); f.notify("child", "child-link", "grandchild"); f.notify("A", "root-link", "child");
  expect(f.delivered).toEqual([]); f.a.bind("A");
  expect(f.delivered.map(({ target, text }) => [target, text])).toEqual([["a", "early-grandchild"], ["a", "child-link"], ["a", "root-link"]]);
  f.notify("A", "bad-link", "B"); f.notify("B", "still-b");
  expect(f.delivered.at(-1)?.target).toBe("b"); expect(f.diagnostics.some((entry) => entry.reason === "conflict")).toBe(true);
  expect(f.a.associations("session/update", { sessionId: "A", child: "B" })).toEqual([]);
  expect(f.a.associations("session/update", { sessionId: "child", child: "grandchild" })).toEqual([{ parent: "child", child: "grandchild" }]);
  f.router.close();
});

test("host requests wait for explicit ownership, and retirement forbids same-id rebind", async () => {
  const f = fixture(); f.a.bind("A");
  expect(() => { f.b.reserve("A"); }).toThrow(SessionUnavailableError);
  expect(f.router.retired("A")).toBe(false);
  const pending = f.router.request("terminal/create", { sessionId: "child" });
  f.notify("A", "link", "child"); const result = await pending; expect(result.target).toBe("a");
  f.a.dispose();
  expect(f.router.retired("A")).toBe(true);
  expect(() => { f.b.reserve("A"); }).toThrow(UnsupportedOptionError);
  expect(() => { f.b.reserve("child"); }).toThrow(UnsupportedOptionError);
  await expect(f.router.request("terminal/create", { sessionId: "child" })).rejects.toThrow("no active native session owner");
  f.router.close();
});

test("unowned host requests expire without selecting any session or executing a handler", async () => {
  vi.useFakeTimers();
  const f = fixture({ waitMs: 20 }); f.a.bind("A"); f.b.bind("B");
  const refused = expect(f.router.request("session/request_permission", { sessionId: "unproved" })).rejects.toThrow("no active native session owner");
  await vi.advanceTimersByTimeAsync(20); await refused;
  expect(f.delivered).toEqual([]); expect(f.diagnostics).toMatchObject([{ reason: "expired", method: "session/request_permission" }]);
  f.router.close();
});

test("frame and byte capacities reject requests visibly, with no broadcast or fabricated end", async () => {
  const f = fixture({ maxFrames: 1, maxBytes: 100 });
  const first = expect(f.router.request("terminal/create", { sessionId: "one" })).rejects.toThrow();
  f.notify("two", "evicts-one"); await first;
  f.notify("large", "x".repeat(150));
  expect(f.diagnostics.map((entry) => entry.reason)).toEqual(["capacity", "capacity"]);
  expect(f.delivered).toEqual([]); f.router.close();
  expect(f.diagnostics.at(-1)?.reason).toBe("connection_closed");
});

test("connection diagnostics redact every lease, including delayed facts after a lease retires", async () => {
  vi.useFakeTimers();
  const f = fixture({ waitMs: 20 });
  const secret = "peer-b-mcp-private-token";
  const b = f.router.attach("secret-b", sessionCredentialRedactor({ mcpServers: [{ name: "b", command: "node", args: [], env: { API_KEY: secret } }] }));
  f.a.bind("A"); b.bind("B-secret");
  f.notify("unknown", secret); b.dispose();
  await vi.advanceTimersByTimeAsync(20);
  f.notify("B-secret", secret);
  expect(JSON.stringify(f.diagnostics)).not.toContain(secret);
  expect(JSON.stringify(f.diagnostics)).toContain("[redacted]");
  expect(f.delivered).toEqual([]);
  expect(f.router.redactValue(new Error(secret)).message).toBe("[redacted]"); f.router.close();
});

test("process closure rejects buffered requests promptly without waiting for their expiry", async () => {
  const f = fixture({ waitMs: 60_000 });
  const waiting = expect(f.router.request("terminal/create", { sessionId: "never" })).rejects.toThrow();
  f.router.close(); await waiting;
  expect(f.diagnostics.at(-1)?.reason).toBe("connection_closed");
});

test("a request resolved just before release loses permission to start host work", async () => {
  const f = fixture(); f.a.bind("A");
  const request = await f.router.request("terminal/create", { sessionId: "A" });
  expect(request.active()).toBe(true); f.a.stopRequests(); expect(request.active()).toBe(false);
  await expect(f.router.request("terminal/create", { sessionId: "A" })).rejects.toThrow("no longer accepts host requests");
  f.notify("A", "late-update"); expect(f.delivered).toMatchObject([{ text: "late-update", target: "a" }]);
  f.router.close();
});


test("new-session collisions are protocol violations, never resume or placement errors", () => {
  const f = fixture(); f.a.bind("A");
  expect(() => { f.b.bind("A"); }).toThrow(AcpProtocolError);
  f.a.dispose();
  expect(() => { f.b.bind("A"); }).toThrow(AcpProtocolError);
  f.router.close();
});

test("resume discards pre-reservation frames and delivers only traffic received after reservation", async () => {
  const f = fixture();
  f.notify("old-root", "unproven-old-update");
  const refused = expect(f.router.request("terminal/create", { sessionId: "old-root" })).rejects.toThrow();
  f.a.reserve("old-root"); await refused;
  f.notify("old-root", "fresh-replay");
  expect(f.delivered.map(entry => entry.text)).toEqual(["fresh-replay"]);
  expect(f.diagnostics.map(entry => entry.reason)).toEqual(["pre_reservation", "pre_reservation"]);
  f.router.close();
});

test("new requests retain early frames beyond expiry while preserving capacity and later expiry", async () => {
  vi.useFakeTimers(); const f = fixture({ waitMs: 20, maxFrames: 2 });
  f.router.newStarted(1); f.router.newStarted(2);
  f.notify("A", "evicted"); f.notify("A", "early-a"); f.notify("B", "early-b");
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.diagnostics.map(entry => entry.reason)).toEqual(["capacity"]);
  f.router.newFinished(1); f.a.bind("A");
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.delivered.map(entry => entry.text)).toEqual(["early-a"]);
  f.router.newFinished(2); f.b.bind("B");
  expect(f.delivered.map(entry => entry.text)).toEqual(["early-a", "early-b"]);
  f.notify("unknown", "expires"); await vi.advanceTimersByTimeAsync(20);
  expect(f.diagnostics.at(-1)?.reason).toBe("expired"); f.router.close();
});

test("an in-flight new also protects frames buffered before the request until it settles", async () => {
  vi.useFakeTimers(); const f = fixture({ waitMs: 20 });
  f.notify("A", "early"); await vi.advanceTimersByTimeAsync(10);
  f.router.newStarted(1); await vi.advanceTimersByTimeAsync(1000);
  expect(f.diagnostics).toEqual([]);
  f.router.newFinished(1); await vi.advanceTimersByTimeAsync(20);
  expect(f.diagnostics.map(entry => entry.reason)).toEqual(["expired"]); f.router.close();
});

test("only a frame from the parent's own root can prove a descendant link", () => {
  const diagnostics: AcpUnattributed[] = []; const received: string[] = [];
  const router = createAcpRouting<string>({ diagnostic: entry => { diagnostics.push(entry); },
    associations: (_method, params) => typeof params.parent === "string" && typeof params.child === "string" ? [{ parent: params.parent, child: params.child }] : [] });
  const a = router.attach("a", sessionCredentialRedactor({})); const b = router.attach("b", sessionCredentialRedactor({}));
  a.bind("A"); b.bind("B");
  router.notify("lineage", { sessionId: "A", parent: "B", child: "stolen" }, () => {});
  router.notify("session/update", { sessionId: "stolen" }, target => { received.push(target); });
  expect(received).toEqual([]);
  expect(a.associations("lineage", { sessionId: "A", parent: "B", child: "stolen" })).toEqual([]);
  router.notify("lineage", { sessionId: "B", parent: "B", child: "stolen" }, () => {});
  expect(received).toEqual(["b"]);
  expect(diagnostics.filter(entry => entry.reason === "conflict")).toHaveLength(1); router.close();
});

test("a pending conflict is diagnosed once, and ordinary traffic does not revisit pending links", () => {
  const diagnostics: AcpUnattributed[] = [];
  const associations = vi.fn((_method: string, params: { readonly sessionId?: unknown; readonly child?: unknown }) => typeof params.sessionId === "string" && typeof params.child === "string" ? [{ parent: params.sessionId, child: params.child }] : []);
  const router = createAcpRouting<string>({ diagnostic: entry => { diagnostics.push(entry); }, associations });
  const a = router.attach("a", sessionCredentialRedactor({})); const b = router.attach("b", sessionCredentialRedactor({}));
  b.bind("B");
  router.notify("lineage", { sessionId: "A", child: "B" }, () => {});
  a.bind("A");
  for (let i = 0; i < 50; i += 1) { router.notify("session/update", { sessionId: "B" }, () => {}); }
  expect(diagnostics.filter(entry => entry.reason === "conflict")).toHaveLength(1);
  expect(associations).toHaveBeenCalledTimes(51); router.close();
});

test("credential union replaces overlapping values longest first, including dynamic and retired values", () => {
  const f = fixture();
  const short = "shared-prefix-secret"; const long = `${short}-more-secret-tail`;
  const a = sessionCredentialRedactor({ env: { API_KEY: short } }); const b = sessionCredentialRedactor({});
  const first = f.router.attach("secret-a", a); first.bind("secret-A");
  const second = f.router.attach("secret-b", b); second.bind("secret-B");
  b.add(long); second.dispose();
  expect(f.router.redact(`${long}|${short}`)).toBe("[redacted]|[redacted]");
  f.router.diagnostic("test", { message: long, cause: new Error(long) });
  expect(f.diagnostics.at(-1)?.params).toMatchObject({ message: "[redacted]", cause: { message: "[redacted]" } });
  expect(JSON.stringify(f.diagnostics)).not.toContain("more-secret-tail"); f.router.close();
});


test("wire traffic arriving before resume is refused even when SDK dispatch follows reservation", async () => {
  const f = fixture();
  const params = { sessionId: "old-root", text: "queued-in-sdk" }; f.router.ingress(params);
  const request = { sessionId: "old-root" }; f.router.ingress(request, "early-host");
  f.a.reserve("old-root");
  f.router.notify("session/update", params, () => { throw new Error("old generation delivered"); });
  await expect(f.router.request("terminal/create", request, "early-host")).rejects.toThrow();
  expect(f.diagnostics.map(entry => entry.reason)).toEqual(["pre_reservation", "pre_reservation"]); f.router.close();
});


test("the shared wire preserves ingress identity across redaction and SDK dispatch", () => {
  const f = fixture(); const wire = sharedAcpWire(f.router, [], () => {});
  const message = wire.incoming({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "old-root", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old" } } } });
  if (message === undefined || !("method" in message)) { throw new Error("fixture notification was dropped"); }
  f.a.reserve("old-root");
  f.router.notify(message.method, message.params, () => { throw new Error("pre-reservation update delivered"); });
  expect(f.diagnostics.map(entry => entry.reason)).toEqual(["pre_reservation"]); f.router.close();
});
