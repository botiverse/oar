import { describe, expect, test } from "vitest";
import { parseUsageHostEvent, parseUsageResult } from "../src/shared/ipc.js";

describe("IPC contracts", () => {
  test("validates the OAR UTC instant representation", () => {
    expect(parseUsageResult({
      kind: "loaded",
      usage: {
        kind: "available",
        email: "captain@example.com",
        rateLimited: false,
        windows: [{
          label: "week",
          usedRatio: 0.25,
          resetsAt: "2026-08-24T12:00:00.000Z",
        }],
      },
    })).toMatchInlineSnapshot(`
      {
        "kind": "loaded",
        "usage": {
          "email": "captain@example.com",
          "kind": "available",
          "rateLimited": false,
          "windows": [
            {
              "label": "week",
              "resetsAt": "2026-08-24T12:00:00.000Z",
              "usedRatio": 0.25,
            },
          ],
        },
      }
    `);

    expect(() => parseUsageResult({
      kind: "loaded",
      usage: {
        kind: "available",
        rateLimited: false,
        windows: [{ label: "week", usedRatio: 0.25, resetsAt: "tomorrow" }],
      },
    })).toThrow("usage reset must be a canonical UTC instant");
  });

  test("validates usage boundary envelopes at the renderer boundary", () => {
    expect(parseUsageHostEvent({
      kind: "usage",
      laneId: "lane-1",
      boundary: {
        turnId: "turn-1",
        phase: "after",
        sampledAt: 1234,
        result: {
          kind: "loaded",
          usage: { kind: "available", rateLimited: false, windows: [] },
        },
      },
    })).toMatchInlineSnapshot(`
      {
        "boundary": {
          "phase": "after",
          "result": {
            "kind": "loaded",
            "usage": {
              "kind": "available",
              "rateLimited": false,
              "windows": [],
            },
          },
          "sampledAt": 1234,
          "turnId": "turn-1",
        },
        "kind": "usage",
        "laneId": "lane-1",
      }
    `);

    expect(() => parseUsageHostEvent({
      kind: "usage",
      laneId: "lane-1",
      boundary: {
        turnId: "turn-1",
        phase: "after",
        sampledAt: Number.NaN,
        result: { kind: "loaded", usage: { kind: "unsupported" } },
      },
    })).toThrow("usage boundary sample time must be finite");
  });
});
