import { expect, test } from "vitest";
import type { Frame, RequestRecord, ResponseRecord, RuntimeEventBody } from "../packages/oar/src/index.js";
import { initialSessionView, reduceSessionViewEvent, viewOf, type SessionView, type ViewTurn } from "../packages/oar/src/observe/session-view.js";

const env: { readonly sessionId: string; readonly agentPath: readonly string[]; readonly receivedAt: number } =
  { sessionId: "s1", agentPath: [], receivedAt: 1 };

function request(seq: number, id: string): RequestRecord {
  return { ...env, seq, kind: "request", id, direction: "toRuntime", body: { kind: "prompt", input: `input ${id}`, inputId: `input-${id}` } };
}
function accepted(seq: number, requestId: string): ResponseRecord {
  return { ...env, seq, kind: "response", requestId, body: { kind: "accepted" } };
}
function frame(seq: number, events: RuntimeEventBody[], sessionId = env.sessionId): Frame {
  return { ...env, sessionId, seq, kind: "frame", body: { type: "native", native: {}, events } };
}
function text(seq: number, value: string): Frame {
  return frame(seq, [{ kind: "text_delta", text: value }]);
}
function turns(view: SessionView): ViewTurn[] {
  return view.messages.filter((message): message is ViewTurn => message.kind === "turn");
}

// SessionOptions.fork.through reads its anchor here, from records or a persisted log alike.
test("a root turn end's fork anchor lands on the turn it stamps; a child's or an anchorless end adds none", () => {
  const view = viewOf([
    request(0, "r1"),
    accepted(1, "r1"),
    text(2, "first"),
    frame(3, [{ kind: "turn_ended", outcome: { kind: "completed" }, forkAnchor: "child-anchor" }], "child"),
    frame(4, [{ kind: "turn_ended", outcome: { kind: "completed" }, forkAnchor: "anchor-1" }]),
    request(5, "r2"),
    accepted(6, "r2"),
    text(7, "second"),
    frame(8, [{ kind: "turn_ended", outcome: { kind: "aborted" } }]),
  ]);
  expect(turns(view).map((turn) => [turn.outcome?.kind, turn.forkAnchor])).toEqual([["completed", "anchor-1"], ["aborted", undefined]]);
  expect(turns(view)[1]).not.toHaveProperty("forkAnchor");
  // Flat events take the same path.
  const flat = reduceSessionViewEvent(initialSessionView(), { ...env, seq: 0, kind: "turn_ended", outcome: { kind: "completed" }, forkAnchor: "anchor-2" });
  expect(turns(flat)[0]?.forkAnchor).toBe("anchor-2");
});
