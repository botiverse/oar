import { expect, test, vi } from "vitest";
import type { ViewPart } from "../packages/oar/src/observe/session-view.js";
import type { classifyTool as ClassifyTool } from "../packages/oar/src/observe/tool-activity.js";

// #318: grouping a live turn on every record classifies only parts it has not seen.
const classifyTool = vi.hoisted(() => vi.fn());
vi.mock("../packages/oar/src/observe/tool-activity.js", async (importOriginal) => {
  const actual = await importOriginal<{ readonly classifyTool: typeof ClassifyTool }>();
  classifyTool.mockImplementation(actual.classifyTool);
  return { ...actual, classifyTool };
});
const { groupToolActivity } = await import("../packages/oar/src/observe/tool-groups.js");

const read: ViewPart = { kind: "tool", callId: "a", tool: "Read", input: '{"file_path":"/w/a.ts"}', result: "ok" };
const edit: ViewPart = { kind: "tool", callId: "b", tool: "Edit", input: '{"file_path":"/w/a.ts"}', result: "running" };

test("each part object is classified once per runtime, however often it is grouped", () => {
  classifyTool.mockClear();
  for (let round = 0; round < 3; round += 1) { groupToolActivity("claude", [read, edit]); }
  expect(classifyTool).toHaveBeenCalledTimes(2);
  groupToolActivity("codex", [read]);
  expect(classifyTool).toHaveBeenCalledTimes(3);
});

test("a replaced part is classified again, an unchanged one is not", () => {
  groupToolActivity("claude", [read, edit]);
  classifyTool.mockClear();
  // The view replaces a part when it changes; it never mutates one.
  const ended: ViewPart = { ...edit, result: "ok" };
  const segments = groupToolActivity("claude", [read, ended]);
  expect(classifyTool).toHaveBeenCalledTimes(1);
  expect(segments).toMatchObject([{ kind: "tools", counts: [{ kind: "read_file", count: 1 }, { kind: "edit_file", count: 1 }] }]);
});
