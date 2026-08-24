import { afterEach, describe, expect, test, vi } from "vitest";
import { formatReset } from "../src/renderer/views/launch/usage-model.js";

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
