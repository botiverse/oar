import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import { runExecutable } from "../../packages/oar/src/shared/executable/index.js";
import { piRpcLaunch } from "../../packages/oar/src/runtimes/pi/rpc/launch.js";
import { createPiRuntime } from "../../packages/oar/src/runtimes/pi/index.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";

vi.mock("../../packages/oar/src/shared/executable/index.js", async (original) => ({ ...await original<object>(), runExecutable: vi.fn() }));

test("the source constant used by bundled hosts matches the installed coding-agent version", async () => {
  const file = new URL("../package.json", import.meta.resolve("@earendil-works/pi-coding-agent"));
  const pkg = asRecord(parseJson(readFileSync(file, "utf8")));
  const { PI_AI_VERSION } = await import("@earendil-works/pi-ai");
  expect(pkg?.version).toBe(PI_AI_VERSION);
});

test("a custom executable gets native RPC arguments and its version is probed in the session environment", async () => {
  vi.mocked(runExecutable).mockResolvedValue({ ok: true, stdout: "1.5.0\n", stderr: "", exitCode: null });
  const env = { PATH: "child-path" };
  expect(await piRpcLaunch("my-host", "project", env, ["pi"])).toMatchInlineSnapshot(`
    {
      "args": [
        "pi",
        "--mode",
        "rpc",
      ],
      "command": "my-host",
      "version": "1.5.0",
    }
  `);
  expect(runExecutable).toHaveBeenLastCalledWith("my-host", ["pi", "--version"], { cwd: "project", env, timeoutMs: 15_000 });
});

test.each(["1.4.0", "1.5.0", "1.6.0", "2.0.0"])("an explicit command accepts the tested floor or a newer version: %s", async (version) => {
  vi.mocked(runExecutable).mockResolvedValue({ ok: true, stdout: version, stderr: "", exitCode: null });
  expect(await piRpcLaunch("my-pi", "project", {})).toEqual({ command: "my-pi", args: ["--mode", "rpc"], version });
});

test.each(["1.3.99", "", "unparseable", "1.5", "01.5.0", "1.5.0\nother output", "1.5.0-beta.1"])("an incompatible or missing explicit native version refuses before a session starts: %s", async (version) => {
  vi.mocked(runExecutable).mockResolvedValue({ ok: true, stdout: version, stderr: "", exitCode: null });
  await expect(piRpcLaunch("my-pi", "project", {})).rejects.toMatchObject({ name: "RuntimeFailureError", failure: "invalid_request",
    message: `Pi RPC requires at least 1.4.0; the selected runtime reports ${version || "no readable version"}. Select a supported Pi executable with createPiRuntime({ execution: "subprocess", command }).` });
});

test.each(["1.4.0", "1.6.0"])("the default entry still requires OAR's exact dependency version: %s", async (version) => {
  vi.mocked(runExecutable).mockResolvedValue({ ok: true, stdout: version, stderr: "", exitCode: null });
  await expect(piRpcLaunch(undefined, "project", {})).rejects.toMatchObject({ name: "RuntimeFailureError", failure: "invalid_request",
    message: `Pi RPC requires 1.5.0, matching OAR's bundled Pi; the selected runtime reports ${version}. Select a supported Pi executable with createPiRuntime({ execution: "subprocess", command }).` });
});

test("a command cannot silently change the default embedded runtime", () => {
  // @ts-expect-error Also reject JavaScript callers that bypass the discriminated options.
  expect(() => createPiRuntime({ command: "my-pi" })).toThrow("A Pi command requires execution: subprocess");
});
