/* oxlint-disable max-statements -- Drive run events, promise completion and queued controls separately. */
import { setImmediate as settle } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { piSession } from "../../packages/oar/src/runtimes/pi/session.js";
import piPreflightFixture from "../fixtures/pi-preflight.js";

const mocks = vi.hoisted(() => ({ sdk: vi.fn() }));
vi.mock("../../packages/oar/src/runtimes/pi/open.js", async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()), openPiAgentSession: mocks.sdk,
}));
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); });

test("SDK keeps queued input behind the owning prompt's unfinished settlement actions", async () => {
  const native = piPreflightFixture();
  mocks.sdk.mockResolvedValue(native.sdk);
  const session = await piSession({ kind: "available", via: "bundled" }, { cwd: process.cwd() });
  try {
    await session.prompt("A"); await session.queue("B");
    native.end(false); await settle();
    await session.queue("C"); await settle();
    expect(native.prompts).toEqual(["A"]);
    native.runs[0]?.resolve(); await settle();
    expect(native.prompts).toEqual(["A", "B"]);
    native.end(); await settle();
    expect(native.prompts).toEqual(["A", "B", "C"]);
  } finally { native.release(); await session.dispose(); }
});

test.each(["before subscription", "after subscription", "before owned prompt completes"] as const)(
  "SDK keeps queued input behind an independent run started %s and its deferred actions", async start => {
    const native = piPreflightFixture();
    const idle = Promise.withResolvers<void>();
    vi.spyOn(native.sdk, "waitForIdle").mockImplementation(async () => { await idle.promise; });
    if (start === "before subscription") { native.sdk.isStreaming = true; }
    mocks.sdk.mockResolvedValue(native.sdk);
    const session = await piSession({ kind: "available", via: "bundled" }, { cwd: process.cwd() });
    try {
      if (start === "before owned prompt completes") {
        await session.prompt("A"); native.end(false); await settle();
      }
      if (start !== "before subscription") { native.begin(); }
      await session.queue("B");
      expect(native.prompts).toEqual(start === "before owned prompt completes" ? ["A"] : []);
      if (start === "before owned prompt completes") { native.runs[0]?.resolve(); await settle(); }
      // Native settlement is visible before its deferred actions finish.
      native.sdk.isStreaming = false; native.settled(); await settle();
      await session.queue("C"); await settle();
      expect(native.prompts).toEqual(start === "before owned prompt completes" ? ["A"] : []);
      idle.resolve(); await settle();
      expect(native.prompts.at(-1)).toBe("B");
      native.end(); await settle();
      expect(native.prompts.slice(-2)).toEqual(["B", "C"]);
    } finally { idle.resolve(); native.release(); await session.dispose(); }
  },
);
