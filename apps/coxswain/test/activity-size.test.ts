import { describe, expect, it } from "vitest";
import {
  activityWidthLimit,
  clampActivityWidth,
  draggedActivityWidth,
} from "../src/renderer/views/cockpit/activity/activity-size.js";

describe("Activity panel sizing", () => {
  it("reserves conversation space while respecting the panel limits", () => {
    expect([
      activityWidthLimit(500),
      activityWidthLimit(900),
      activityWidthLimit(1500),
    ]).toMatchInlineSnapshot(`
      [
        260,
        580,
        720,
      ]
    `);
  });

  it("clamps and rounds requested widths", () => {
    expect([
      clampActivityWidth(100, 1000),
      clampActivityWidth(456.6, 1000),
      clampActivityWidth(800, 1000),
    ]).toMatchInlineSnapshot(`
      [
        260,
        457,
        680,
      ]
    `);
  });

  it("grows when its left edge moves left and shrinks when it moves right", () => {
    expect([
      draggedActivityWidth(380, 700, 600, 1000),
      draggedActivityWidth(380, 700, 760, 1000),
    ]).toMatchInlineSnapshot(`
      [
        480,
        320,
      ]
    `);
  });
});
