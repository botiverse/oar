import { describe, expect, it } from "vitest";
import { invocationEvidence } from "../experiments/sharing/mcp-scope.js";
import { compareDirectoryConfiguration } from "../experiments/sharing/directory-configuration.js";

const call = (server: string, input: string): { server: string; input: string; output: string } => ({ server, input, output: `MCP_RESULT=${server} input=${input}` });

describe("MCP isolation evidence", () => {
  it("does not let an old correct result conceal a later wrong configuration", () => {
    const calls = [call("A", "A_before"), call("B", "A_after"), call("B", "B_after")];
    expect(invocationEvidence(calls, "A_before", "A").isolated).toBe(true);
    expect(invocationEvidence(calls, "A_after", "A")).toMatchInlineSnapshot(`
      {
        "calls": [
          {
            "input": "A_after",
            "output": "MCP_RESULT=B input=A_after",
            "server": "B",
          },
        ],
        "expectedServer": "A",
        "input": "A_after",
        "isolated": false,
      }
    `);
  });
  it("requires exactly one matching invocation and its actual output", () => {
    expect(invocationEvidence([], "A_after", "A").isolated).toBe(false);
    expect(invocationEvidence([call("A", "A_after"), call("B", "A_after")], "A_after", "A").isolated).toBe(false);
    expect(invocationEvidence([{ ...call("A", "A_after"), output: "MCP_RESULT=B input=A_after" }], "A_after", "A").isolated).toBe(false);
    expect(invocationEvidence([call("A", "A_after")], "A_after", "A").isolated).toBe(true);
  });
});

const configurationRow = (revision: "A" | "B") => ({
  turns: [{ input: "B_mcpafter", directoryRuleMarkers: { initial: revision === "A", changed: revision === "B" } }],
  directoryConfiguration: { hooks: [{ revision, event: { tool_input: { text: "B_mcpafter" } } }] },
});

describe("configuration freshness evidence", () => {
  it("keeps absent instruction and hook observations unknown", () => {
    expect(compareDirectoryConfiguration({}, {})).toMatchObject({ projectMarkersMatch: null, hookRevisionsMatch: null, differenceObserved: false });
  });
  it("compares follow-up sessions even when only their user hooks remain stale", () => {
    const shared = { newSession: { directoryRuleMarkers: { initial: false, changed: true } },
      directoryConfiguration: { hooks: [{ revision: "A", event: { tool_input: { text: "B_mcpfreshafter" } } }] } };
    const separate = { ...shared,
      directoryConfiguration: { hooks: [{ revision: "B", event: { tool_input: { text: "B_mcpfreshafter" } } }] } };
    expect(compareDirectoryConfiguration(shared, separate, "B_mcpfreshafter")).toMatchObject({
      projectMarkersMatch: true, hookRevisionsMatch: false, differenceObserved: true,
    });
  });
  it("detects stale instructions and hooks in a later shared session", () => {
    expect(compareDirectoryConfiguration(configurationRow("A"), configurationRow("B"))).toMatchObject({ projectMarkersMatch: false, hookRevisionsMatch: false, differenceObserved: true });
    expect(compareDirectoryConfiguration(configurationRow("B"), configurationRow("B"))).toMatchObject({ projectMarkersMatch: true, hookRevisionsMatch: true, differenceObserved: false });
  });
});
