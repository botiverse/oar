import { expect, test, vi } from "vitest";
import { opencodeRuntime } from "../../packages/oar/src/runtimes/opencode/index.js";
import { skillFailureReason } from "../../packages/oar/src/runtimes/opencode/skill-diagnostic.js";

const run = vi.hoisted(() => vi.fn());
vi.mock("../../packages/oar/src/shared/executable/run.js", () => ({ runExecutable: run }));

test("v1 skill failure retains exit and a bounded, redacted first stderr line", async () => {
  run.mockResolvedValue({ ok: false, exitCode: 7, stdout: "PRIVATE STDOUT", stderr: "Native startup failed: token=synthetic-private-value\nPRIVATE SECOND LINE\n" });
  await expect(opencodeRuntime.skills({ kind: "available", via: "executable", command: "opencode", version: "1.18.30" })).resolves.toMatchInlineSnapshot(`
    {
      "code": "query_failed",
      "kind": "unavailable",
      "reason": "OpenCode skill discovery failed (exit 7): Native startup failed: token=[redacted]",
    }
  `);
});

test("the first stderr line survives long native logs", async () => {
  run.mockResolvedValue({ ok: false, exitCode: 1, stdout: "", stderr: `ConfigInvalidError: fixture\n${"tail\n".repeat(4000)}` });
  await expect(opencodeRuntime.skills({ kind: "available", via: "executable", command: "opencode", version: "1.18.30" })).resolves.toMatchInlineSnapshot(`
    {
      "code": "query_failed",
      "kind": "unavailable",
      "reason": "OpenCode skill discovery failed (exit 1): ConfigInvalidError: fixture",
    }
  `);
});

test("redaction precedes truncation and handles escaped credentials and terminal escapes", () => {
  const secret = "synthetic-private-key";
  const text = `\u001B[31m${"x".repeat(490)}${secret}\u001B[0m\nSECOND LINE`;
  expect(skillFailureReason(1, text, { API_KEY: secret })).toBe(`OpenCode skill discovery failed (exit 1): ${"x".repeat(490)}[redacted]`);
  const multiline = "synthetic\nprivate\"key";
  for (const value of [multiline, JSON.stringify(multiline).slice(1, -1), encodeURIComponent(multiline)]) {
    expect(skillFailureReason(2, `Failed ${value}`, { API_KEY: multiline })).toBe("OpenCode skill discovery failed (exit 2): Failed [redacted]");
  }
});

test.each([
  ["accessToken=unrecognized", "accessToken=[redacted]"],
  ["Bearer opaque-value", "[redacted authorization]"],
  ["Authorization: Bearer unrecognized-value", "Authorization=[redacted]"],
  ['"apiKey": "unrecognized value with spaces"', '"apiKey=[redacted]'],
  ["url https://user:password@example.invalid/path?key=value", "url [redacted URL]"],
  ["key sk-syntheticprivate123456", "key [redacted]"],
  ["token ghp_syntheticprivate", "token [redacted]"],
  ["\r\n first line\rsecond line", "first line"],
])("native credential shapes and first-line handling: %s", (input, expected) => {
  expect(skillFailureReason(1, input, {})).toBe(`OpenCode skill discovery failed (exit 1): ${expected}`);
});

test("empty stderr, invalid catalogs and oversized lines remain explicit and bounded", () => {
  expect(skillFailureReason(null, "", {})).toBe("OpenCode skill discovery failed (no exit code)");
  expect(skillFailureReason(0, "", {}, 9)).toBe("OpenCode skill discovery failed (exit 0; output was not valid JSON or a skill catalog (9 bytes, truncated?))");
  expect(skillFailureReason(1, "x".repeat(9000), {})).toBe(`OpenCode skill discovery failed (exit 1): ${"x".repeat(500)}...`);
});
