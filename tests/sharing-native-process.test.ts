import { expect, test } from "vitest";
import { selectNativeProcess } from "../experiments/sharing/native-process.js";

const root = { pid: 100, ppid: 1, pgid: 100, start: "root-start" };
const child = { pid: 101, ppid: 100, pgid: 100, start: "child-start" };
const table = new Map([[root.pid, root], [child.pid, child]]);

test("an exec-replaced root is selected instead of its transient first helper", () => {
  expect(selectNativeProcess(root, table, { names: new Map([[100, "codex"], [101, "git"]]), expected: "codex" }).selected).toEqual(root);
});
test("a native child under the Windows Node wrapper is selected by executable", () => {
  expect(selectNativeProcess(root, table, { names: new Map([[100, "node.exe"], [101, "codex.exe"]]), expected: "codex" }).selected).toEqual(child);
});
test("missing or ambiguous native identity cannot silently select a PID", () => {
  expect(() => selectNativeProcess(root, table, { names: new Map([[100, "node"], [101, "git"]]), expected: "codex" })).toThrow("exactly one");
  expect(() => selectNativeProcess(root, table, { names: new Map([[100, "codex"], [101, "codex"]]), expected: "codex" })).toThrow("exactly one");
  expect(() => selectNativeProcess({ ...root, start: "old" }, table, { names: new Map([[100, "codex"]]), expected: "codex" })).toThrow("identity changed");
});
