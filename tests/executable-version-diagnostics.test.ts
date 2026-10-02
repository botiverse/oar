import assert from "node:assert/strict";
import { afterEach, expect, test, vi } from "vitest";
import type { ProcessDiagnostics } from "../packages/oar/src/shared/executable/diagnostics.js";
import type { ExecutableRunner } from "../packages/oar/src/shared/executable/run.js";
import { readExecutableVersion } from "../packages/oar/src/shared/executable/version.js";

const runExecutable = vi.hoisted(() => vi.fn<ExecutableRunner>());
vi.mock("../packages/oar/src/shared/executable/run.js", () => ({ runExecutable }));
afterEach(() => { runExecutable.mockReset(); });

async function versionFailure(diagnostics: ProcessDiagnostics) {
  runExecutable.mockResolvedValue({
    ok: false, stdout: "", exitCode: diagnostics.exitCode, stderr: diagnostics.stderr, diagnostics,
  });
  const failure: unknown = await readExecutableVersion("runtime", 5000).catch((error: unknown) => error);
  assert.ok(failure instanceof Error);
  return { message: failure.message, cause: failure.cause };
}

test("version probes retain native spawn errors and stderr", async () => {
  expect(await versionFailure({
    exitCode: null, signal: null, stderr: "loader detail",
    error: { code: "EINVAL", message: "spawn EINVAL" },
  })).toMatchInlineSnapshot(`
    {
      "cause": {
        "error": {
          "code": "EINVAL",
          "message": "spawn EINVAL",
        },
        "exitCode": null,
        "signal": null,
        "stderr": "loader detail",
      },
      "message": "Failed to run runtime --version: exit code unavailable; signal none; EINVAL: spawn EINVAL
    stderr (tail):
    loader detail",
    }
  `);
});

test("a version timeout is an error even when the wrapper exits with a numeric code", async () => {
  expect(await versionFailure({
    exitCode: 1, signal: null, stderr: "still starting", timeoutMs: 5000,
  })).toMatchInlineSnapshot(`
    {
      "cause": {
        "exitCode": 1,
        "signal": null,
        "stderr": "still starting",
        "timeoutMs": 5000,
      },
      "message": "Failed to run runtime --version: exit code 1; signal none; timeout after 5000 ms
    stderr (tail):
    still starting",
    }
  `);
});

test("a version probe terminated by a signal preserves that signal", async () => {
  expect(await versionFailure({ exitCode: null, signal: "SIGTERM", stderr: "terminated" })).toMatchInlineSnapshot(`
    {
      "cause": {
        "exitCode": null,
        "signal": "SIGTERM",
        "stderr": "terminated",
      },
      "message": "Failed to run runtime --version: exit code unavailable; signal SIGTERM
    stderr (tail):
    terminated",
    }
  `);
});

test("an ordinary nonzero version exit still means unavailable version, with the same deadline", async () => {
  runExecutable.mockResolvedValue({ ok: false, exitCode: 2, stdout: "", stderr: "unsupported flag" });
  expect(await readExecutableVersion("runtime", 321)).toBeUndefined();
  expect(runExecutable.mock.calls).toMatchInlineSnapshot(`
    [
      [
        "runtime",
        [
          "--version",
        ],
        {
          "timeoutMs": 321,
        },
      ],
    ]
  `);
});
