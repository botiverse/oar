import { afterEach, describe, expect, test, vi } from "vitest";
import { utcInstantFromDate, type AccountUsageSnapshot } from "@botiverse/oar";
import type { UsageBoundaryView } from "../src/shared/ipc.js";
import { formatReset } from "../src/renderer/views/launch/usage-model.js";
import { usageForTurn, usageViewsByTurn } from "../src/renderer/views/usage-helm/usage-model.js";

const resetAt = utcInstantFromDate(new Date("2026-08-24T00:00:00.000Z"));
if (resetAt === null) {
  throw new Error("invalid usage test reset");
}

function boundary(
  turnId: string,
  phase: "before" | "after",
  sampledAt: number,
  usage: AccountUsageSnapshot,
): UsageBoundaryView {
  return {
    turnId,
    phase,
    sampledAt,
    result: { kind: "loaded", usage },
  };
}

describe("formatReset", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("shows the local reset date and time", () => {
    const format = vi.spyOn(Date.prototype, "toLocaleString")
      .mockReturnValue("8/24/26, 3:39 AM");

    expect(formatReset("2026-08-23T19:39:00.000Z"))
      .toBe(" · resets 8/24/26, 3:39 AM");
    expect(format).toHaveBeenCalledWith([], {
      dateStyle: "short",
      timeStyle: "short",
    });
  });

  test("omits missing or invalid reset instants", () => {
    expect(formatReset(undefined)).toBe("");
    expect(formatReset("not-a-date")).toBe("");
  });
});

describe("usage helm projection", () => {
  test("derives per-window delta, burn rate, and time-to-limit", () => {
    const view = usageForTurn([
      boundary("turn-1", "before", 1000, {
        kind: "available",
        rateLimited: false,
        windows: [{ label: "session", usedRatio: 0.2, resetsAt: resetAt }],
      }),
      boundary("turn-1", "after", 61_000, {
        kind: "available",
        plan: "Max",
        rateLimited: false,
        windows: [{ label: "session", usedRatio: 0.3, resetsAt: resetAt }],
      }),
    ], "turn-1");

    expect(view).toMatchInlineSnapshot(`
      {
        "afterAt": 61000,
        "beforeAt": 1000,
        "elapsedMs": 60000,
        "plan": "Max",
        "rateLimited": false,
        "status": "available",
        "turnId": "turn-1",
        "windows": [
          {
            "afterRatio": 0.3,
            "beforeRatio": 0.2,
            "burnRatePerMinute": 0.09999999999999998,
            "deltaRatio": 0.09999999999999998,
            "label": "session",
            "projectedLimitAt": 481000.00000000006,
            "reset": false,
            "resetBeforeProjection": false,
            "resetsAt": "2026-08-24T00:00:00.000Z",
          },
        ],
      }
    `);
  });

  test("marks a lower reading as a reset and does not invent a burn rate", () => {
    const view = usageForTurn([
      boundary("turn-reset", "before", 1000, {
        kind: "available",
        rateLimited: false,
        windows: [{ label: "session", usedRatio: 0.8 }],
      }),
      boundary("turn-reset", "after", 61_000, {
        kind: "available",
        rateLimited: false,
        windows: [{ label: "session", usedRatio: 0.1 }],
      }),
    ], "turn-reset");

    expect(view?.windows).toEqual([{
      label: "session",
      beforeRatio: 0.8,
      afterRatio: 0.1,
      deltaRatio: -0.7000000000000001,
      reset: true,
      resetBeforeProjection: false,
    }]);
  });

  test("preserves reauth and unsupported states while a turn is sampled", () => {
    expect(usageForTurn([
      boundary("reauth", "before", 10, { kind: "reauth_required" }),
    ], "reauth")).toEqual({
      turnId: "reauth",
      status: "reauth_required",
      beforeAt: 10,
      windows: [],
      reason: "sign in again to inspect account usage",
    });
    expect(usageForTurn([
      boundary("unsupported", "after", 20, { kind: "unsupported" }),
    ], "unsupported")).toEqual({
      turnId: "unsupported",
      status: "unsupported",
      afterAt: 20,
      windows: [],
      reason: "account usage is not exposed by this runtime",
    });
  });

  test("indexes multiple turns without mixing their baselines", () => {
    const boundaries = [
      boundary("one", "before", 0, { kind: "available", rateLimited: false, windows: [{ label: "all", usedRatio: 0.1 }] }),
      boundary("two", "before", 100, { kind: "available", rateLimited: false, windows: [{ label: "all", usedRatio: 0.4 }] }),
      boundary("one", "after", 60_000, { kind: "available", rateLimited: false, windows: [{ label: "all", usedRatio: 0.2 }] }),
      boundary("two", "after", 100_100, { kind: "available", rateLimited: false, windows: [{ label: "all", usedRatio: 0.5 }] }),
    ];
    const views = usageViewsByTurn(boundaries);
    expect([...views.keys()]).toEqual(["one", "two"]);
    expect(views.get("one")?.windows[0]?.deltaRatio).toBeCloseTo(0.1);
    expect(views.get("two")?.windows[0]?.deltaRatio).toBeCloseTo(0.1);
  });
});
