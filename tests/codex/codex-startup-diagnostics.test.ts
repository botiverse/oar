import assert from "node:assert/strict";
import { expect, test } from "vitest";
import { codexSession } from "../../packages/oar/src/runtimes/codex/session.js";

test("a failed spawn is caught through session initialization without an unhandled rejection", async () => {
  const failure: unknown = await codexSession({
    kind: "available", via: "executable", command: "/nonexistent/oar-codex-startup-fixture",
  }, { cwd: process.cwd() }).catch((error: unknown) => error);
  assert.ok(failure instanceof Error);
  expect({ message: failure.message, cause: failure.cause }).toMatchInlineSnapshot(`
    {
      "cause": {
        "error": {
          "code": "ENOENT",
          "message": "spawn /nonexistent/oar-codex-startup-fixture ENOENT",
        },
        "exitCode": null,
        "signal": null,
        "stderr": "",
      },
      "message": "app-server exited: exit code unavailable; signal none; ENOENT: spawn /nonexistent/oar-codex-startup-fixture ENOENT",
    }
  `);
});
