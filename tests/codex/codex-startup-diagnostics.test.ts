import assert from "node:assert/strict";
import { expect, test } from "vitest";
import { codexSession } from "../../packages/oar/src/runtimes/codex/session.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";

test("a failed spawn is caught through session initialization without an unhandled rejection", async () => {
  const failure: unknown = await codexSession({
    kind: "available", via: "executable", command: "/nonexistent/oar-codex-startup-fixture",
  }, { cwd: process.cwd() }).catch((error: unknown) => error);
  assert.ok(failure instanceof Error);
  const cause = asRecord(failure.cause);
  assert.ok(typeof cause?.stderr === "string");
  // Windows's shell adds localized stderr for ENOENT; POSIX emits none.
  // Its text varies, but the exception must carry exactly the captured tail.
  const suffix = cause.stderr === "" ? "" : `\nstderr (tail):\n${cause.stderr}`;
  expect(failure.message).toBe(`app-server exited: exit code unavailable; signal none; ENOENT: spawn /nonexistent/oar-codex-startup-fixture ENOENT${suffix}`);
  expect({ ...cause, stderr: "<native stderr>" }).toMatchInlineSnapshot(`
    {
      "error": {
        "code": "ENOENT",
        "message": "spawn /nonexistent/oar-codex-startup-fixture ENOENT",
      },
      "exitCode": null,
      "signal": null,
      "stderr": "<native stderr>",
    }
  `);
});
