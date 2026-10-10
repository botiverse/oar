/* oxlint-disable eslint/max-lines-per-function -- Inline snapshots retain the complete native-derived event shapes. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import { opencodeChildAttribution } from "../../packages/oar/src/runtimes/opencode/attribution.js";
import { createAcpRecorder } from "../../packages/oar/src/shared/acp/records.js";
import { createUsageUpdateGate } from "../../packages/oar/src/shared/acp/usage-wait.js";
import { createSessionKernel } from "../../packages/oar/src/shared/session-kernel.js";
import { asRecord, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { classifyTool, graphOf, usageOf, viewOf } from "../../packages/oar/src/observe/index.js";
import type { SessionNotification } from "../../packages/oar/src/shared/acp/process.js";

const fixtureText = readFileSync(new URL("../replay/fixtures/opencode-acp-v2-child.json", import.meta.url), "utf8");
const fixture = asRecord(parseJson(fixtureText));
assert.ok(Array.isArray(fixture?.notifications));
// oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion -- Captured through the SDK's validated notification callback; preserve every vendor extension verbatim.
const notifications = fixture.notifications as SessionNotification[];
function recorder() {
  const kernel = createSessionKernel("root");
  const gate = { ...createUsageUpdateGate(), observe: vi.fn() };
  const records = createAcpRecorder(gate, opencodeChildAttribution);
  records.bind(kernel);
  return { kernel, records, gate };
}

// oxlint-disable-next-line eslint/max-statements -- Recorded native attribution, persistence and its full snapshot are one regression.
test("recorded v2 child shell and text keep their own session and verbatim parent envelope", () => {
  const { kernel, records } = recorder();
  for (const notification of notifications) { records.update(notification); }
  // oxlint-disable-next-line typescript/no-unsafe-assignment, unicorn/prefer-structured-clone -- The host retains JSON records, never a live kernel graph.
  const persisted: ReturnType<typeof kernel.records> = JSON.parse(JSON.stringify(kernel.records()));
  expect(graphOf(persisted)).toEqual(kernel.graph());
  expect(viewOf(persisted).usage).toEqual(usageOf(persisted, "root").value);
  expect(kernel.graph()).toMatchInlineSnapshot(`
    {
      "edges": [
        {
          "child": "child-1",
          "parent": "root",
          "via": "tool_call",
        },
      ],
      "nodes": [
        {
          "id": "root",
        },
        {
          "id": "child-1",
        },
      ],
    }
  `);
  expect(kernel.records().flatMap((record) => record.kind === "frame" && record.sessionId !== "root" ? [{ sessionId: record.sessionId, events: record.body.events }] : [])).toMatchInlineSnapshot(`
    [
      {
        "events": [
          {
            "callId": "child-1:call-2",
            "input": "{"cwd":"/project"}",
            "kind": "tool_call_started",
            "tool": "shell",
          },
          {
            "child": "child-1",
            "kind": "session_linked",
            "parent": "root",
            "via": "tool_call",
          },
        ],
        "sessionId": "child-1",
      },
      {
        "events": [
          {
            "callId": "child-1:call-2",
            "input": "{"command":"echo CHILD-OK-7731","cwd":"/project"}",
            "kind": "tool_call_input",
          },
          {
            "child": "child-1",
            "kind": "session_linked",
            "parent": "root",
            "via": "tool_call",
          },
        ],
        "sessionId": "child-1",
      },
      {
        "events": [
          {
            "child": "child-1",
            "kind": "session_linked",
            "parent": "root",
            "via": "tool_call",
          },
        ],
        "sessionId": "child-1",
      },
      {
        "events": [
          {
            "callId": "child-1:call-2",
            "content": [
              {
                "text": "CHILD-OK-7731
    ",
                "type": "text",
              },
            ],
            "kind": "tool_call_ended",
            "result": "ok",
          },
          {
            "child": "child-1",
            "kind": "session_linked",
            "parent": "root",
            "via": "tool_call",
          },
        ],
        "sessionId": "child-1",
      },
      {
        "events": [
          {
            "kind": "text_delta",
            "text": "CHILD-OK-7731",
          },
          {
            "child": "child-1",
            "kind": "session_linked",
            "parent": "root",
            "via": "tool_call",
          },
        ],
        "sessionId": "child-1",
      },
    ]
  `);
  for (const [index, record] of kernel.records().entries()) {
    assert.equal(record.kind, "frame");
    expect(record.body.native).toBe(notifications[index]);
  }
  // Both live subscription and replay use the same frame envelopes; child text is never root text.
  expect(kernel.records().flatMap((record) => record.kind === "frame" && record.sessionId === "root" ? record.body.events.filter((event) => event.kind === "text_delta") : [])).toMatchInlineSnapshot(`
    [
      {
        "kind": "text_delta",
        "text": "CHILD-OK-7731",
      },
    ]
  `);
});

function childUpdate(child: JsonRecord, update: SessionNotification["update"]): SessionNotification {
  return { sessionId: "root", update: { ...update, _meta: { "opencode/child-session": child } } };
}

test("nested descendants link their reported parent and never satisfy root usage waiting", () => {
  const { kernel, records, gate } = recorder();
  records.update(childUpdate({ id: "grandchild", parentID: "child", depth: 2 }, { sessionUpdate: "usage_update", used: 77, size: 100 }));
  expect(gate.observe).not.toHaveBeenCalled();
  expect(kernel.graph()).toMatchInlineSnapshot(`
    {
      "edges": [
        {
          "child": "grandchild",
          "parent": "child",
          "via": "tool_call",
        },
      ],
      "nodes": [
        {
          "id": "root",
        },
        {
          "id": "grandchild",
        },
        {
          "id": "child",
        },
      ],
    }
  `);
  expect(kernel.records().map((record) => ({ sessionId: record.sessionId, body: record.body }))).toMatchInlineSnapshot(`
    [
      {
        "body": {
          "events": [
            {
              "kind": "usage",
              "usage": {
                "context": {
                  "contextWindow": 100,
                  "percent": 77,
                  "tokens": 77,
                },
              },
            },
            {
              "child": "grandchild",
              "kind": "session_linked",
              "parent": "child",
              "via": "tool_call",
            },
          ],
          "native": {
            "sessionId": "root",
            "update": {
              "_meta": {
                "opencode/child-session": {
                  "depth": 2,
                  "id": "grandchild",
                  "parentID": "child",
                },
              },
              "sessionUpdate": "usage_update",
              "size": 100,
              "used": 77,
            },
          },
          "type": "usage_update",
        },
        "sessionId": "grandchild",
      },
    ]
  `);
});

test.each([{}, { id: "child" }, { id: "", parentID: "root" }, { id: "root", parentID: "root" }])("incomplete lineage is not fabricated: %j", (meta) => {
  expect(opencodeChildAttribution(childUpdate(meta, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "native" } }))).toBeNull();
});

test("the envelope metadata spelling works even when update metadata has other fields", () => {
  expect(opencodeChildAttribution({ sessionId: "root", _meta: { "opencode/child-session": { id: "child", parentID: "root" } }, update: { sessionUpdate: "future", _meta: { extra: true } } })).toMatchInlineSnapshot(`
    {
      "parent": "root",
      "sessionId": "child",
    }
  `);
});

test("tool classification retains v1 bash and recognizes v2 shell without pretending generic Code Mode is MCP", () => {
  expect(["bash", "shell", "subagent", "execute"].map((tool) => ({ tool, action: classifyTool("opencode", tool, '{"command":"echo CHILD-OK-7731","code":"return 1"}') }))).toMatchInlineSnapshot(`
    [
      {
        "action": {
          "command": "echo CHILD-OK-7731",
          "detail": "echo CHILD-OK-7731",
          "kind": "run_command",
        },
        "tool": "bash",
      },
      {
        "action": {
          "command": "echo CHILD-OK-7731",
          "detail": "echo CHILD-OK-7731",
          "kind": "run_command",
        },
        "tool": "shell",
      },
      {
        "action": {
          "detail": "echo CHILD-OK-7731",
          "kind": "other",
        },
        "tool": "subagent",
      },
      {
        "action": {
          "detail": "echo CHILD-OK-7731",
          "kind": "other",
        },
        "tool": "execute",
      },
    ]
  `);
});
