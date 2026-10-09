import { expect, test } from "vitest";
import type { Frame, RawEvent, RequestRecord, RuntimeEventBody } from "../packages/oar/src/index.js";
import {
  initialSessionView, reduceSessionView, reduceSessionViewEvent, viewOf,
  type SessionView, type ViewPart,
} from "../packages/oar/src/observe/session-view.js";

const root = { sessionId: "root", agentPath: [], receivedAt: 1 } as const;
const childSession = { sessionId: "child", agentPath: [] } as const;
const childAgent = { sessionId: "root", agentPath: ["toolu_agent"] } as const;
interface Lane { readonly sessionId: string; readonly agentPath: readonly string[] }

function request(seq: number, kind: "prompt" | "steer" = "prompt"): RequestRecord {
  return {
    ...root, seq, kind: "request", id: `r${seq}`, direction: "toRuntime",
    body: { kind, input: "go", inputId: `i${seq}` },
  };
}
function frame(seq: number, events: readonly RuntimeEventBody[], lane: Lane = root): Frame {
  return { ...root, ...lane, seq, kind: "frame", body: { type: "native", native: {}, events } };
}
function text(value: string, messageId?: string): RuntimeEventBody {
  return { kind: "text_delta", text: value, ...(messageId === undefined ? {} : { messageId }) };
}
function reasoning(value: string, messageId?: string): RuntimeEventBody {
  return { kind: "reasoning", content: { kind: "text", text: value }, ...(messageId === undefined ? {} : { messageId }) };
}
function sections(view: SessionView) {
  return view.messages.filter((message) => message.kind === "turn").map((turn) => turn.sections);
}
/** Compact snapshots retain every part's identity, kind and readable content. */
function partSummary(part: ViewPart): string {
  switch (part.kind) {
    case "text": return `text(${part.messageId ?? "unnamed"}): ${part.text}`;
    case "reasoning": return `reasoning(${part.messageId ?? "unnamed"}): ${part.content.kind === "text" ? part.content.text : `[${part.content.kind}]`}`;
    case "tool": return `tool(${part.callId}): ${part.tool}`;
    case "notice": return `notice: ${part.notice.cause}`;
    case "app_request": return `app_request: ${part.requestId}`;
  }
  const exhaustive: never = part;
  return exhaustive;
}
function partsBySection(view: SessionView) {
  return sections(view).map((turn) => turn.map((section) => section.parts.map(partSummary)));
}

test("Codex child-session messages stay whole across alternating lanes (#257)", () => {
  const view = viewOf([
    request(0),
    frame(1, [text("A1", "m_child")], childSession),
    frame(2, [text("B1", "m_root")]),
    frame(3, [text("A2", "m_child")], childSession),
    frame(4, [text("B2", "m_root")]),
  ]);
  expect(sections(view)).toMatchInlineSnapshot(`
    [
      [
        {
          "agentPath": [],
          "parts": [
            {
              "kind": "text",
              "messageId": "m_child",
              "text": "A1A2",
            },
          ],
          "sessionId": "child",
        },
        {
          "agentPath": [],
          "parts": [
            {
              "kind": "text",
              "messageId": "m_root",
              "text": "B1B2",
            },
          ],
          "sessionId": "root",
        },
      ],
    ]
  `);
});

test.each([childSession, childAgent, { sessionId: "root", agentPath: ["nested", "agent"] }])(
  "equal text and reasoning IDs stay scoped to their lane: %j",
  (child) => {
    const view = viewOf([
      request(0),
      frame(1, [text("A1", "same"), reasoning("R1", "same")], child),
      frame(2, [text("B1", "same"), reasoning("S1", "same")]),
      frame(3, [text("A2", "same"), reasoning("R2", "same")], child),
      frame(4, [text("B2", "same"), reasoning("S2", "same")]),
    ]);
    expect(sections(view)[0]?.map(({ sessionId, agentPath }) => ({ sessionId, agentPath }))).toEqual([
      child, { sessionId: "root", agentPath: [] },
    ]);
    expect(partsBySection(view)).toMatchInlineSnapshot(`
      [
        [
          [
            "text(same): A1A2",
            "reasoning(same): R1R2",
          ],
          [
            "text(same): B1B2",
            "reasoning(same): S1S2",
          ],
        ],
      ]
    `);
  },
);

test("named parts rejoin past tools, notices and other message IDs without moving them", () => {
  const view = viewOf([
    request(0),
    frame(1, [text("A1", "a"), reasoning("R1", "a")]),
    frame(2, [{ kind: "tool_call_started", callId: "call", tool: "Read" }]),
    frame(3, [{ kind: "retry", attempt: 1 }, text("B1", "b"), reasoning("S1", "b")]),
    frame(4, [text("A2", "a"), reasoning("R2", "a")]),
  ]);
  expect(partsBySection(view)).toMatchInlineSnapshot(`
    [
      [
        [
          "text(a): A1A2",
          "reasoning(a): R1R2",
          "tool(call): Read",
          "notice: retry",
          "text(b): B1",
          "reasoning(b): S1",
        ],
      ],
    ]
  `);
});

test("named reasoning keeps distinct IDs and lifecycle-only facts", () => {
  const view = viewOf([
    request(0),
    frame(1, [reasoning("A1", "a"), reasoning("B1", "b")]),
    frame(2, [{ kind: "reasoning", content: { kind: "redacted" }, messageId: "a" }]),
    frame(3, [{ kind: "reasoning", content: { kind: "empty" }, messageId: "a" }]),
    frame(4, [reasoning("A2", "a"), reasoning("B2", "b")]),
  ]);
  expect(partsBySection(view)).toMatchInlineSnapshot(`
    [
      [
        [
          "reasoning(a): A1A2",
          "reasoning(b): B1B2",
          "reasoning(a): [redacted]",
          "reasoning(a): [empty]",
        ],
      ],
    ]
  `);
});

function beforeInput(echoes: boolean): RawEvent[] {
  return [
    request(0),
    ...(echoes ? [frame(1, [{ kind: "user_message", input: "go", inputId: "i0", evidence: "acknowledged" }])] : []),
    frame(2, [text("before", "m"), reasoning("before", "m")]),
    frame(3, [text("child before", "child")], childAgent),
    request(4, "steer"),
  ];
}

test.each([false, true])("continuing messages start new parts after an input seal (native echo: %s)", (echoes) => {
  const before = beforeInput(echoes);
  expect(viewOf(before).openTurn === -1).toBe(!echoes);
  const view = viewOf([
    ...before,
    ...(echoes ? [frame(5, [{ kind: "user_message", input: "go", inputId: "i4", evidence: "acknowledged" }])] : []),
    frame(6, [text("after", "m"), reasoning("after", "m")]),
    frame(7, [text("child after", "child")], childAgent),
    frame(8, [text("!", "m"), reasoning("!", "m")]),
  ]);
  expect(view.messages.map((message) => message.kind)).toEqual(["input", "turn", "input", "turn"]);
  expect(partsBySection(view)).toMatchInlineSnapshot(`
    [
      [
        [
          "text(m): before",
          "reasoning(m): before",
        ],
        [
          "text(child): child before",
        ],
      ],
      [
        [
          "text(m): after!",
          "reasoning(m): after!",
        ],
        [
          "text(child): child after",
        ],
      ],
    ]
  `);
});

test("text and reasoning without IDs, tools and notices still append in lane order", () => {
  const view = viewOf([
    request(0),
    frame(1, [text("A1"), reasoning("R1")], childAgent),
    frame(2, [text("B1")]),
    frame(3, [text("A2"), reasoning("R2")], childAgent),
    frame(4, [{ kind: "tool_call_started", callId: "call", tool: "Read" }]),
    frame(5, [{ kind: "retry", attempt: 1 }], childAgent),
  ]);
  expect(partsBySection(view)).toMatchInlineSnapshot(`
    [
      [
        [
          "text(unnamed): A1",
          "reasoning(unnamed): R1",
        ],
        [
          "text(unnamed): B1",
        ],
        [
          "text(unnamed): A2",
          "reasoning(unnamed): R2",
        ],
        [
          "tool(call): Read",
        ],
        [
          "notice: retry",
        ],
      ],
    ]
  `);
});

test("incremental updates preserve earlier views and equal replay, including repeated records", () => {
  const records = [
    request(0),
    frame(1, [text("A1", "a"), reasoning("R1", "a")], childSession),
    frame(2, [text("B1", "b")]),
    frame(3, [text("A2", "a"), reasoning("R2", "a")], childSession),
    frame(4, [text("B2", "b")]),
  ];
  let view = initialSessionView();
  for (const [index, record] of records.entries()) {
    const previous = structuredClone(view);
    const next = reduceSessionView(view, record);
    expect(view).toEqual(previous);
    expect(next).toEqual(viewOf(records.slice(0, index + 1)));
    expect(reduceSessionView(next, record).messages).toEqual(next.messages);
    view = next;
  }
  expect(sections(view)[0]).toHaveLength(2);
});

test("the flat-event fold also joins named messages and does not cross a turn end", () => {
  const events = [
    { ...root, seq: 0, kind: "text_delta", text: "A1", messageId: "a" },
    { ...root, ...childAgent, seq: 1, kind: "text_delta", text: "B1", messageId: "b" },
    { ...root, seq: 2, kind: "text_delta", text: "A2", messageId: "a" },
    { ...root, seq: 3, kind: "turn_ended", outcome: { kind: "completed" } },
    { ...root, seq: 4, kind: "text_delta", text: "new turn", messageId: "a" },
  ] as const;
  const view = events.reduce((state, event) => reduceSessionViewEvent(state, event), initialSessionView());
  expect(partsBySection(view)).toMatchInlineSnapshot(`
    [
      [
        [
          "text(a): A1A2",
        ],
        [
          "text(b): B1",
        ],
      ],
      [
        [
          "text(a): new turn",
        ],
      ],
    ]
  `);
});
