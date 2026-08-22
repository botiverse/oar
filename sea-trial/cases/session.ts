import type { SessionEvent, Turn } from "../../packages/oar/src/contracts/session.js";
import type { TrialCase } from "../harness/runner.js";

function expectTurn(result: { kind: "turn"; turn: Turn } | { kind: "busy" }): Turn {
  if (result.kind !== "turn") {
    throw new Error("expected a turn but the session reported busy");
  }
  return result.turn;
}

export const sessionCases: readonly TrialCase[] = [
  {
    id: "session.framing-and-attribution",
    requires: ["installation", "session"],
    async run(subject) {
      const session = await subject.startSession();
      const events: SessionEvent[] = [];
      session.subscribe((event) => {
        events.push(event);
      });
      const turn = expectTurn(session.prompt("hello"));
      const outcome = await turn.outcome;
      if (outcome.kind !== "completed") {
        throw new Error(`expected completed, got ${outcome.kind}`);
      }
      if (events[0]?.kind !== "turn_started" || events.at(-1)?.kind !== "turn_ended") {
        throw new Error("turn events are not framed by turn_started … turn_ended");
      }
      for (const [index, event] of events.entries()) {
        if (event.sessionId !== session.id || event.turnId !== turn.id) {
          throw new Error("event attribution crossed wires");
        }
        if (index > 0 && event.seq <= (events[index - 1]?.seq ?? Number.NaN)) {
          throw new Error("seq is not strictly increasing");
        }
      }
      await session.dispose();
    },
  },
  {
    id: "session.single-active-turn",
    requires: ["installation", "session"],
    async run(subject) {
      const session = await subject.startSession();
      const first = expectTurn(session.prompt("one"));
      if (session.prompt("two").kind !== "busy") {
        throw new Error("second prompt during an active turn was not busy");
      }
      await first.outcome;
      const third = session.prompt("three");
      if (third.kind !== "turn") {
        throw new Error("prompt after settlement should start a turn");
      }
      await third.turn.outcome;
      await session.dispose();
    },
  },
  {
    // Race-honest by design: on a real runtime the turn may complete before
    // the interrupt lands, and the runtime's truth wins. What every runtime
    // MUST honor: abort settles the turn, the outcome is aborted or completed
    // (never failed), and a late abort changes nothing. The strong
    // "abort actually aborts a long turn" claim lives in the live experiments.
    id: "session.abort-settles-and-is-idempotent",
    requires: ["installation", "session"],
    async run(subject) {
      const session = await subject.startSession();
      const turn = expectTurn(session.prompt("slow"));
      await turn.abort();
      const outcome = await turn.outcome;
      if (outcome.kind === "failed") {
        throw new Error(`abort produced a failure: ${outcome.reason}`);
      }
      await turn.abort();
      const second = await turn.outcome;
      if (second.kind !== outcome.kind) {
        throw new Error("late abort changed a settled outcome");
      }
      await session.dispose();
    },
  },
  {
    id: "session.steer-after-end",
    requires: ["installation", "session"],
    async run(subject) {
      const session = await subject.startSession();
      const turn = expectTurn(session.prompt("hello"));
      await turn.outcome;
      const late = await turn.steer?.("too late");
      if (late !== undefined && late.kind !== "not_steerable") {
        throw new Error("steer through an ended turn handle must be not_steerable");
      }
      await session.dispose();
    },
  },
  {
    id: "session.observer-isolation",
    requires: ["installation", "session"],
    async run(subject) {
      const session = await subject.startSession();
      const seen: string[] = [];
      session.subscribe(() => {
        throw new Error("observer deliberately hostile");
      });
      session.subscribe((event) => {
        seen.push(event.kind);
      });
      const turn = expectTurn(session.prompt("hello"));
      const outcome = await turn.outcome;
      if (outcome.kind !== "completed") {
        throw new Error("a throwing observer affected the run");
      }
      if (!seen.includes("turn_started") || !seen.includes("turn_ended")) {
        throw new Error("a throwing observer starved a later observer");
      }
      await session.dispose();
    },
  },
];
