import assert from "node:assert/strict";
import { afterEach, expect, test, vi } from "vitest";
import type { ExecutableRunner } from "../packages/oar/src/shared/executable/run.js";
import { executableInstallation } from "../packages/oar/src/shared/installation.js";

const runExecutable = vi.hoisted(() => vi.fn<ExecutableRunner>());
vi.mock("../packages/oar/src/shared/executable/index.js", async (original) => ({
  ...await original<Record<string, unknown>>(),
  runExecutable,
}));
afterEach(() => { runExecutable.mockReset(); });

test("an installation spawn error preserves the native code and stderr", async () => {
  runExecutable.mockResolvedValue({
    ok: false, exitCode: null, stdout: "", stderr: "loader detail",
    diagnostics: {
      exitCode: null, signal: null, stderr: "loader detail",
      error: { code: "EINVAL", message: "spawn EINVAL" },
    },
  });
  const probe = executableInstallation("OAR_DIAGNOSTIC_FIXTURE_BIN", process.execPath, [], ["--ready"]);
  const failure: unknown = await probe().catch((error: unknown) => error);
  assert.ok(failure instanceof Error);
  expect(failure.message.replace(process.execPath, "<node>")).toMatchInlineSnapshot(`
    "Failed to run <node> --ready: exit code unavailable; signal none; EINVAL: spawn EINVAL
    stderr (tail):
    loader detail"
  `);
  expect(failure.cause).toMatchInlineSnapshot(`
    {
      "error": {
        "code": "EINVAL",
        "message": "spawn EINVAL",
      },
      "exitCode": null,
      "signal": null,
      "stderr": "loader detail",
    }
  `);
});
