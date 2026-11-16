/* oxlint-disable max-statements -- Observe bootstrap binding and the next admission in one ordered regression. */
import { afterEach, expect, test, vi } from "vitest";
import { piSession } from "../../packages/oar/src/runtimes/pi/session.js";
import piPreflightFixture from "../fixtures/pi-preflight.js";

const mocks = vi.hoisted(() => ({ sdk: vi.fn() }));
vi.mock("../../packages/oar/src/runtimes/pi/open.js", async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()), openPiAgentSession: mocks.sdk,
}));
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); });

test.each([false, true])("SDK observes a bootstrap run emitted by bindExtensions (completed: %s)", async completed => {
  const native = piPreflightFixture();
  const binding = vi.spyOn(native.sdk, "bindExtensions").mockImplementation(async () => {
    native.begin();
    if (completed) { native.end(); }
  });
  mocks.sdk.mockResolvedValue(native.sdk);
  const session = await piSession({ kind: "available", via: "bundled" }, { cwd: process.cwd() });
  try {
    expect(binding).toHaveBeenCalledOnce();
    const events = session.records().flatMap(record => record.kind === "frame" ? record.body.events : []);
    expect(events.filter(event => event.kind === "turn_active")).toHaveLength(1);
    expect(events.filter(event => event.kind === "turn_ended")).toHaveLength(completed ? 1 : 0);
    expect(session.status().value.kind).toBe(completed ? "idle" : "running");
    if (!completed) {
      expect(await session.prompt("D")).toMatchObject({ kind: "rejected", code: "busy" });
      expect(native.prompts).toEqual([]);
      native.end();
    }
    expect(await session.prompt("NEXT")).toMatchObject({ kind: "accepted" });
    expect(native.prompts).toEqual(["NEXT"]);
  } finally { native.release(); await session.dispose(); }
});
