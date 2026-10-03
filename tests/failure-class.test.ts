import { expect, test } from "vitest";
import { classifyFailure } from "../packages/oar/src/shared/failure-class.js";

test.each([
  // claude 2.1.288, reported from Ferry (#70)
  ["Failed to authenticate: OAuth session expired and could not be refreshed", "auth"],
  ["Not logged in", "auth"],
  ["Invalid API key · Please run /login", "auth"],
  // @cursor/sdk 1.0.35, a run without a usable credential
  ["[unknown] Invalid User API Key", "auth"],
  ["429 rate limit exceeded", "quota"],
  ["Overloaded", "overloaded"],
  ["the agent stopped", "unknown"],
] as const)("%s is classified %s", (reason, expected) => {
  expect(classifyFailure(reason)).toBe(expected);
});
