import { setImmediate } from "node:timers/promises";
import { expect, test, vi } from "vitest";
// oxlint-disable-next-line import/no-namespace -- Observe native initialization without replacing its eventual behavior.
import * as initialize from "../../packages/oar/src/shared/acp/initialize.js";
// oxlint-disable-next-line import/no-namespace -- Observe the actual process launch count while initialization is blocked.
import * as acp from "../../packages/oar/src/shared/acp/process.js";
import { fixture, opening } from "../fixtures/acp-shared-support.js";
import { openCodeDirectoryReservation } from "../../packages/oar/src/runtimes/opencode/shared-session.js";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";

test("a failed shared open retains its directory reservation while a peer keeps the process alive", async () => {
  const f = await fixture({ reserveSession: openCodeDirectoryReservation() }, { configureSession: async ({ options }) => {
    await Promise.resolve();
    if (options.cwd.endsWith("failed")) { throw new Error("configuration failed"); }
  } });
  const a = await f.open("a");
  await expect(f.open("failed")).rejects.toThrow("configuration failed");
  await expect(f.open("failed", {}, "shared")).rejects.toMatchObject({ option: "placement" });
  const b = await f.open("b"); expect(opening(a)?.pid).toBe(opening(b)?.pid);
  expect(await promptAndWait(a, "alive")).toMatchObject({ kind: "ended" });
});

// oxlint-disable-next-line eslint/max-statements -- The gate proves ordering without relying on process startup speed.
test("same-directory auto fallback waits for the shared process initialization before launching another", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const refused = Promise.withResolvers<void>();
  const actual = initialize.initializeAcpConnection;
  const init = vi.spyOn(initialize, "initializeAcpConnection").mockImplementationOnce(async (...args) => {
    entered.resolve(); await release.promise;
    const ready = await actual(...args); return ready;
  });
  const launches = vi.spyOn(acp, "startAcpProcess");
  const reserve = openCodeDirectoryReservation();
  const f = await fixture({ reserveSession: async (...args) => {
    const reason = await reserve(...args); if (reason !== null) { refused.resolve(); } return reason;
  } });
  const first = f.open("a");
  let second: ReturnType<typeof f.open> | undefined = undefined;
  try {
    await entered.promise;
    second = f.open("a");
    await refused.promise;
    await setImmediate();
    expect(launches).toHaveBeenCalledTimes(1);
    release.resolve();
    const [a, b] = await Promise.all([first, second]);
    expect([a.placement, b.placement]).toEqual(["shared", "isolated"]);
    expect(opening(a)?.pid).not.toBe(opening(b)?.pid);
    expect(launches).toHaveBeenCalledTimes(2);
  } finally {
    release.resolve(); await Promise.allSettled([first, ...(second === undefined ? [] : [second])]);
    init.mockRestore(); launches.mockRestore();
  }
});
