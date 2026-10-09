/* oxlint-disable eslint/max-lines-per-function, eslint/max-statements -- The snapshot keeps the captured tool lifecycle and its replay assertions together. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { opencodeChildAttribution } from "../../packages/oar/src/runtimes/opencode/attribution.js";
import { createAcpRecorder } from "../../packages/oar/src/shared/acp/records.js";
import { createUsageUpdateGate } from "../../packages/oar/src/shared/acp/usage-wait.js";
import { createSessionKernel } from "../../packages/oar/src/shared/session-kernel.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";
import { classifyTool } from "../../packages/oar/src/observe/tool-activity.js";
import type { SessionNotification } from "../../packages/oar/src/shared/acp/process.js";

const fixtureText = readFileSync(new URL("../replay/fixtures/opencode-acp-v2-mcp.json", import.meta.url), "utf8");
const fixture = asRecord(parseJson(fixtureText));
assert.ok(Array.isArray(fixture?.notifications));
// oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion -- Captured through the SDK's validated callback, retaining native extension fields.
const notifications = fixture.notifications as SessionNotification[];

test("native v2 MCP through execute retains code, tool result and metadata without renaming the tool", () => {
  const kernel = createSessionKernel("root");
  const recorder = createAcpRecorder(createUsageUpdateGate(), opencodeChildAttribution);
  recorder.bind(kernel);
  for (const notification of notifications) { recorder.update(notification); }
  const records = kernel.records();
  expect(records.flatMap((record) => record.kind === "frame" ? record.body.events : [])).toMatchInlineSnapshot(`
    [
      {
        "callId": "execute-echo",
        "input": "{}",
        "kind": "tool_call_started",
        "tool": "execute",
      },
      {
        "callId": "execute-echo",
        "input": "{"code":" await tools.echo.echo({ text: \\"MCP_NEW_271\\" })"}",
        "kind": "tool_call_input",
      },
      {
        "callId": "execute-echo",
        "content": [
          {
            "text": "echo:MCP_NEW_271 via=stdio token=none",
            "type": "text",
          },
        ],
        "kind": "tool_call_ended",
        "result": "ok",
      },
    ]
  `);
  for (const [index, record] of records.entries()) {
    assert.equal(record.kind, "frame");
    expect(record.sessionId).toBe("root");
    expect(record.body.native).toBe(notifications[index]);
  }
  const input = notifications.map((notification) => asRecord(asRecord(notification.update)?.rawInput)).find((value) => value?.code !== undefined);
  expect(classifyTool("opencode", "execute", JSON.stringify(input))).toMatchInlineSnapshot(`
    {
      "detail": "execute",
      "kind": "other",
    }
  `);
  expect(kernel.graph()).toMatchInlineSnapshot(`
    {
      "edges": [],
      "nodes": [
        {
          "id": "root",
        },
      ],
    }
  `);
});
