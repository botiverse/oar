import { expect, it } from "vitest";
import { nativeHookCompletions, hookExecutionFailures, nativeContextShells } from "../experiments/sharing/hook-completions.js";
import { directoryFailureReasons } from "../experiments/sharing/directory-failures.js";

it("retains native failure status and message-derived exit without copying paths or IDs", () => {
  const nativeHookCompletionsValue = nativeHookCompletions({ events: [{ method: "hook/completed", params: {
    threadId: "private-id", run: { id: "private-hook", sourcePath: "/private/home/hooks.json", eventName: "preToolUse",
      status: "failed", entries: [{ kind: "error", text: "hook exited with code 1" }] },
  } }] });
  expect(nativeHookCompletionsValue).toEqual([expect.objectContaining({ status: "failed", exitCode: 1, exitCodeSource: "native completion message" })]);
  expect(JSON.stringify(nativeHookCompletionsValue)).not.toContain("private");
  const row = { mode: "shared", nativeHookCompletions: nativeHookCompletionsValue };
  expect(hookExecutionFailures(row, "shared")).toEqual(["shared: hook command execution failed (exit 1)"]);
  expect(directoryFailureReasons({ cohorts: [row] })).toContain("shared: hook command execution failed (exit 1)");
});

it("distinguishes absent completions and failure without an exit code", () => {
  expect(nativeHookCompletions({ events: [] })).toEqual([]);
  const completions = nativeHookCompletions({ events: [{ method: "hook/completed", params: { run: { status: "failed", entries: [] } } }] });
  expect(completions[0]?.exitCode).toBeNull();
  expect(hookExecutionFailures({ nativeHookCompletions: completions }, "B")).toEqual(["B: hook command execution failed (native status failed)"]);
});

it("retains a shell reported by native environment context without unrelated shell mentions", () => {
  expect(nativeContextShells({ normalized: [{ request: "<environment_context><cwd>/private</cwd><shell>powershell</shell></environment_context>" },
    { request: "An ordinary <shell>cmd</shell> mention" }] })).toEqual(["powershell"]);
});
