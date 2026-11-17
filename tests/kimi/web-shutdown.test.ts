import { afterEach, expect, test, vi } from "vitest";
import { fakeLineProcess } from "../fixtures/fake-line-process.js";
import { stopKimiWeb, KIMI_WEB_SHUTDOWN_GRACE_MS } from "../../packages/oar/src/runtimes/kimi/web-shutdown.js";

const web = { origin: "http://127.0.0.1:45678", token: "synthetic-private" };
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); vi.restoreAllMocks(); });

// oxlint-disable-next-line max-statements -- Retain every ordering and ownership observation.
test("native shutdown captures descendants, authenticates privately and joins actual exit", async () => {
  const child = fakeLineProcess(); const order: string[] = [];
  vi.spyOn(child, "prepareShutdown").mockImplementation(async () => { order.push("capture"); });
  vi.spyOn(child, "markNativeStop").mockImplementation(() => { order.push("stop"); });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    order.push("request"); expect(url).toBe(`${web.origin}/api/v1/shutdown`);
    expect(init).toMatchObject({ method: "POST", redirect: "error", headers: { Authorization: "Bearer synthetic-private" } });
    expect(init?.signal?.aborted).toBe(false); return Response.json({ code: 0, data: { ok: true } });
  }));
  let settled = false; const pending = (async () => { await stopKimiWeb(child, web); settled = true; })();
  await vi.waitFor(() => { expect(order).toEqual(["capture", "stop", "request"]); });
  expect(settled).toBe(false); expect(child.killed()).toBe(false);
  child.end(0); await pending; expect(child.killed()).toBe(false);
});

test.each(["request hangs", "exit hangs"])("bounded cleanup falls back when %s", async mode => {
  vi.useFakeTimers(); const child = fakeLineProcess();
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (mode === "exit hangs") { return Response.json({ code: 0, data: {} }); }
    const { promise, reject } = Promise.withResolvers<Response>();
    init?.signal?.addEventListener("abort", () => { reject(new Error("private failure")); }, { once: true }); return promise;
  }));
  const pending = stopKimiWeb(child, web);
  await vi.advanceTimersByTimeAsync(KIMI_WEB_SHUTDOWN_GRACE_MS - 1); expect(child.killed()).toBe(false);
  await vi.advanceTimersByTimeAsync(1); await pending;
  expect(child.killed()).toBe(true); expect(vi.getTimerCount()).toBe(0);
});

test("failed native shutdown falls back and still waits for cleanup", async () => {
  const child = fakeLineProcess(); const kill = vi.spyOn(child, "kill").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
  let settled = false; const pending = (async () => { await stopKimiWeb(child, web); settled = true; })();
  await vi.waitFor(() => { expect(kill).toHaveBeenCalledOnce(); }); expect(settled).toBe(false);
  child.end(null); await expect(pending).resolves.toBeUndefined();
});
