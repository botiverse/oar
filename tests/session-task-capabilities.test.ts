import { describe, expect, it } from "vitest";
import type { AvailableInstallation } from "../packages/oar/src/index.js";
import { allRuntimes } from "../sea-trial/harness/runtimes.js";

const executable = (version?: string): AvailableInstallation => ({ kind: "available", via: "executable", command: "/bin/agent", ...(version === undefined ? {} : { version }) });

describe("native task records and child output", () => {
  it.each([
    ["claude", "2.1.292", ["workflow"], undefined],
    ["claude", "2.1.326", ["agent", "shell", "workflow"], { foreground: "parent_tool_result", background: "child_text" }],
    ["codex", "0.169.0", ["agent"], { background: "child_text" }],
    ["dsh", undefined, undefined, undefined],
    ["dsh", "0.2.1-rc.5", ["agent", "shell"], undefined],
    ["dsh", "0.2.2-rc.5", ["agent", "shell"], { background: "child_text" }],
    ["grok", "1.0.70", ["agent"], { foreground: "parent_tool_result", background: "task_output" }],
    ["qoder", "1.1.83", ["agent"], undefined],
    ["qwen", "0.27.4", ["agent"], { foreground: "parent_tool_result" }],
    ["kimi", "2.6.3", [], { foreground: "parent_tool_result" }],
    ["opencode", "1.19.5", [], { foreground: "parent_tool_result" }],
    ["opencode", "2.2.7", [], { foreground: "parent_tool_result" }],
    ["opencode", "2.3.0", ["agent"], { background: "child_text" }],
    ["opencode", undefined, undefined, undefined],
  ] as const)("%s %s declares measured modes independently", (...row) => {
    const [id, version, types, results] = row;
    const declaration = allRuntimes.require(id).sessionCapabilities?.(executable(version));
    expect(declaration?.taskEventTypes).toEqual(types);
    expect(declaration?.subagentResults).toEqual(results);
  });

  it.each(["antigravity", "codebuddy", "cursor", "devin", "factory", "pi"])("%s explicitly has no native task projection", id => {
    expect(allRuntimes.require(id).sessionCapabilities?.(executable()).taskEventTypes).toEqual([]);
  });
});
