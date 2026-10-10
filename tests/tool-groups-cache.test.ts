import { expect, test, vi } from "vitest";
import type { ViewPart } from "../packages/oar/src/observe/session-view.js";
import type { classifyTool as ClassifyTool } from "../packages/oar/src/observe/tool-activity.js";

// #318: grouping classifies a call by runtime and tool name, never by parsing its input.
const classifyTool = vi.hoisted(() => vi.fn());
vi.mock("../packages/oar/src/observe/tool-activity.js", async (importOriginal) => {
  const actual = await importOriginal<{ readonly classifyTool: typeof ClassifyTool }>();
  classifyTool.mockImplementation(actual.classifyTool);
  return { ...actual, classifyTool };
});
const { groupToolActivity } = await import("../packages/oar/src/observe/tool-groups.js");

test("grouping never hands a call's input to classifyTool, and the counts stay the same", () => {
  const huge = JSON.stringify({ file_path: "/w/a.ts", content: "x".repeat(200_000) });
  const parts: ViewPart[] = [
    { kind: "tool", callId: "a", tool: "Read", input: '{"file_path":"/w/a.ts"}', result: "ok" },
    { kind: "tool", callId: "b", tool: "Write", input: huge, result: "running" },
  ];
  const segments = groupToolActivity("claude", parts);
  expect(classifyTool.mock.calls.map((call) => call.length)).toEqual([2, 2]);
  expect(segments).toMatchObject([{ kind: "tools", counts: [{ kind: "read_file", count: 1 }, { kind: "edit_file", count: 1 }] }]);
});
