import { expect, test } from "vitest";
import type { Frame } from "../packages/oar/src/contracts/session.js";
import { initialSessionView, reduceSessionView, viewOf } from "../packages/oar/src/observe/session-view.js";

function report(seq: number, tier: string, scope: { sessionId?: string; agentPath?: readonly string[] } = {}): Frame {
  return { kind: "frame", seq, sessionId: scope.sessionId ?? "root", agentPath: scope.agentPath ?? [], receivedAt: seq,
    body: { type: "native", native: {}, events: [{ kind: "service_tier", serviceTier: tier }] } };
}

test("view reads only root tier reports and explicit default, identically on replay", () => {
  expect(initialSessionView().serviceTier).toBeNull();
  const records = [report(0, "priority"), report(1, "flex", { sessionId: "child" }), report(2, "flex", { agentPath: ["agent"] })];
  expect(viewOf(records).serviceTier).toBe("priority");
  records.push(report(3, "default"));
  expect(viewOf(records).serviceTier).toBe("default");
  expect(records.reduce((view, record) => reduceSessionView(view, record), initialSessionView())).toEqual(viewOf(records));
});
