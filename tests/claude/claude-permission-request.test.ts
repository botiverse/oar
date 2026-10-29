/* oxlint-disable max-statements -- Assert the received request and absence of both native and public replies together. */
import { afterEach, expect, test, vi } from "vitest";
import { claudeSession } from "../../packages/oar/src/runtimes/claude/session.js";
import { fakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
afterEach(() => { spawnLineProcess.mockReset(); });

// Native Claude 2.1.311 sends this shape when its stdio permission target is enabled.
// Explicit modes use none and prompt targets are refused. If a request still
// reaches the adapter, retain the native fact without inventing an answer.
test("Claude records a permission request without granting it or replying", async () => {
  const child = fakeLineProcess();
  spawnLineProcess.mockReturnValue(child);
  const session = await claudeSession({ kind: "available", via: "executable", command: "claude", version: "2.1.311" }, { cwd: "/work" });
  const native = { type: "control_request", request_id: "permission-1", request: {
    subtype: "can_use_tool", tool_name: "Bash", input: { command: "echo probe" }, tool_use_id: "tool-1",
  } };
  try {
    const before = [...child.written];
    child.emit(`${JSON.stringify(native)}\n`);
    await Promise.resolve();
    expect(child.written).toEqual(before);
    expect(session.records().filter((record) => record.kind === "request").map((record) => ({ id: record.body.kind === "open" ? "<open>" : record.id, direction: record.direction, body: record.body }))).toMatchInlineSnapshot(`
      [
        {
          "body": {
            "kind": "open",
            "placement": "auto",
          },
          "direction": "toRuntime",
          "id": "<open>",
        },
        {
          "body": {
            "kind": "native",
            "native": {
              "request": {
                "input": {
                  "command": "echo probe",
                },
                "subtype": "can_use_tool",
                "tool_name": "Bash",
                "tool_use_id": "tool-1",
              },
              "request_id": "permission-1",
              "type": "control_request",
            },
            "type": "can_use_tool",
          },
          "direction": "toApp",
          "id": "permission-1",
        },
      ]
    `);
    expect(session.records().filter((record) => record.kind === "response").map((record) => record.body)).toEqual([{ kind: "opened", placement: "isolated" }]);
    expect("answer" in session).toBe(false);
  } finally { await session.dispose(); }
});
