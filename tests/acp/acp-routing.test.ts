/* oxlint-disable eslint/max-statements -- Each test retains the full routing sequence and its observable assertions. */
import { afterEach, expect, test, vi } from "vitest";
import { UnsupportedOptionError } from "../../packages/oar/src/contracts/errors.js";
import { sessionCredentialRedactor } from "../../packages/oar/src/shared/credential-redactor.js";
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
  const pending = f.router.request("terminal/create", { sessionId: "child" });
  f.notify("A", "link", "child"); const result = await pending; expect(result.target).toBe("a");
  f.a.dispose();
  expect(() => { f.b.bind("A"); }).toThrow(UnsupportedOptionError);
  expect(() => { f.b.bind("child"); }).toThrow(UnsupportedOptionError);
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
