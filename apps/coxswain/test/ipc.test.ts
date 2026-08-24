import { describe, expect, test } from "vitest";
import { parseUsageResult } from "../src/shared/ipc.js";

describe("IPC contracts", () => {
  test("validates the OAR UTC instant representation", () => {
    expect(parseUsageResult({
      kind: "loaded",
      usage: {
        kind: "available",
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
});
