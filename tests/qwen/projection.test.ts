import { expect, test } from "vitest";
import { qwenEffort, qwenMcpConfig } from "../../packages/oar/src/runtimes/qwen/session.js";
import { initialQwenProjection, qwenProjectionProfile, qwenUsage } from "../../packages/oar/src/runtimes/qwen/projection.js";
import { projectQwenModels } from "../../packages/oar/src/runtimes/qwen/list-models.js";
import { checkQwenLaunchArgs } from "../../packages/oar/src/runtimes/qwen/options.js";
import { streamJsonPrompted } from "../../packages/oar/src/shared/stream-json/input-lifecycle.js";
import { foldStreamJsonStdout } from "../../packages/oar/src/shared/stream-json/projection.js";

test("no-lifecycle input identities never enter the Claude acknowledgement sets", () => {
  let state = initialQwenProjection();
  for (const inputId of ["a", "b", "c"]) {
    state = streamJsonPrompted(state, inputId, true, false);
    for (const message of [{ type: "system", subtype: "init", model: "model" }, { type: "result", subtype: "success", is_error: false }]) {
      ({ state } = foldStreamJsonStdout(qwenProjectionProfile, state, message));
    }
    expect(state.unacknowledgedInputs.size).toBe(0);
    expect(state.unstartedInputs.size).toBe(0);
    expect(state.promptInputs.size).toBe(0);
    expect(state.pendingInputId).toBeNull();
  }
});

test("reported usage includes cache reads once; missing usage is unknown", () => {
  expect(qwenUsage({ usage: { input_tokens: 20, output_tokens: 4, cache_read_input_tokens: 8 } })).toEqual({ input: 20, output: 4, cacheRead: 8 });
  expect(qwenUsage({})).toBeNull();
});

const answer = (status: unknown) => ({ response: { response: { effort_status: status } } });

test("effort needs native confirmation and does not echo an absent or overridden setting", () => {

  expect(qwenEffort(answer(undefined))).toEqual([]);
  expect(qwenEffort(answer({ effort: "high", applied: true, override: null }), "high")).toEqual([{ kind: "effort", effort: "high" }]);
  for (const status of [undefined, { effort: "low", applied: true, override: null }, { effort: "high", applied: false, override: null }, { effort: "high", applied: true, override: { source: "env" } }]) {
    expect(() => qwenEffort(answer(status), "high")).toThrow(/high/u);
  }
});

test("model menus come from the native capabilities, with no assumed defaults", () => {
  expect(projectQwenModels({ models: [{ id: "raw", label: "Raw" }, { id: "reason", capabilities: { reasoning: { efforts: ["low", "max"], defaultEffort: "max" } } }] })).toEqual([
    { id: "raw", displayName: "Raw" }, { id: "reason", effortLevels: ["low", "max"], defaultEffort: "max" },
  ]);
});

test("MCP HTTP uses httpUrl; launch arguments cannot change OAR's protocol or identity", () => {
  expect(qwenMcpConfig([{ name: "remote", type: "http", url: "https://example.test/mcp", headers: { Authorization: "fixture" } }])).toEqual({ remote: { httpUrl: "https://example.test/mcp", headers: { Authorization: "fixture" } } });
  for (const flag of ["--channel=CLI", "--approval-mode=default", "--resume", "--output-format=text", "-p", "-otext", "-o=text", "--inputFormat=text", "--approvalMode=default", "--"]) {
    expect(() => { checkQwenLaunchArgs([flag]); }).toThrow(/launchArgs/u);
  }
});


test("runtime tool-result and reminder frames preserve native data without inventing host input", () => {
  const tool = { type: "tool_result", tool_use_id: "native-echo", is_error: false, content: "echo:native-probe via=stdio token=none" };
  const reminder = { type: "text", text: "<system-reminder>Runtime memory catalog</system-reminder>" };
  for (const content of [[tool], [tool, reminder], [reminder]]) {
    const native = { type: "user", uuid: "runtime-generated-id", session_id: "conversation", parent_tool_use_id: null, message: { role: "user", content } };
    const { commands } = foldStreamJsonStdout(qwenProjectionProfile, initialQwenProjection(), native);
    const [command] = commands;
    if (command?.kind !== "frame") { throw new Error("Expected the original native frame"); }
    expect(command.body.native).toBe(native);
    expect(command.body.events).toEqual(content.includes(tool)
      ? [{ kind: "tool_call_ended", callId: "native-echo", content: [{ type: "text", text: "echo:native-probe via=stdio token=none" }], result: "ok" }]
      : []);
  }
});
