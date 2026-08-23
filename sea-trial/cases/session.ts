import assert from "node:assert/strict";
import type { SessionEvent, Turn } from "../../packages/oar/src/contracts/session.js";
import type { TrialCase } from "../harness/runner.js";

function expectTurn(result: { kind: "turn"; turn: Turn } | { kind: "busy" }): Turn {
  assert.ok(result.kind === "turn", "expected a turn but the session reported busy");
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
      assert.deepEqual(outcome, { kind: "completed" });
      assert.equal(events[0]?.kind, "turn_started");
      assert.equal(events.at(-1)?.kind, "turn_ended");
      for (const [index, event] of events.entries()) {
        assert.ok(event.sessionId === session.id && event.turnId === turn.id, "event attribution crossed wires");
        if (index > 0) {
          assert.ok(event.seq > (events[index - 1]?.seq ?? Number.NaN), "seq is not strictly increasing");
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
      assert.equal(session.prompt("two").kind, "busy", "second prompt during an active turn was not busy");
      await first.outcome;
      const third = session.prompt("three");
      assert.ok(third.kind === "turn", "prompt after settlement should start a turn");
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
      assert.ok(outcome.kind !== "failed", `abort produced a failure: ${JSON.stringify(outcome)}`);
      await turn.abort();
      const second = await turn.outcome;
      assert.equal(second.kind, outcome.kind, "late abort changed a settled outcome");
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
      if (late !== undefined) {
        assert.equal(late.kind, "not_steerable", "steer through an ended turn handle must be not_steerable");
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
      assert.deepEqual(outcome, { kind: "completed" }, "a throwing observer affected the run");
      assert.ok(seen.includes("turn_started") && seen.includes("turn_ended"), "a throwing observer starved a later observer");
      await session.dispose();
    },
  },
  {
    id: "session.multi-turn-conversation",
    requires: ["installation", "session"],
    async run(subject) {
      const session = await subject.startSession();
      const events: SessionEvent[] = [];
      session.subscribe((event) => {
        events.push(event);
      });
      for (const input of ["one", "two", "three"]) {
        const turn = expectTurn(session.prompt(input));
        assert.deepEqual(await turn.outcome, { kind: "completed" });
      }
      const frames = events
        .filter((event) => event.kind === "turn_started" || event.kind === "turn_ended")
        .map((event) => event.kind);
      assert.deepEqual(frames, [
        "turn_started", "turn_ended",
        "turn_started", "turn_ended",
        "turn_started", "turn_ended",
      ], "each turn is framed independently");
      const turnIds = new Set(events.map((event) => event.turnId));
      assert.equal(turnIds.size, 3, "three turns have three distinct ids");
      for (const [index, event] of events.entries()) {
        if (index > 0) {
          assert.ok(event.seq > (events[index - 1]?.seq ?? Number.NaN), "seq stays strictly increasing across turns");
        }
      }
      await session.dispose();
    },
  },
  {
    // Race-honest: on a real runtime the turn may end before the steer lands,
    // so both accepted and not_steerable are lawful. What every runtime MUST
    // honor: a mid-turn steer never throws, never corrupts the turn, and the
    // turn still settles without failing. Strong acceptance/visibility claims
    // live in the live experiments.
    id: "session.steer-mid-turn",
    requires: ["installation", "session"],
    async run(subject) {
      const session = await subject.startSession();
      const turn = expectTurn(session.prompt("please answer slow-ly"));
      // The result is typed (accepted | not_steerable) at compile time; the
      // runtime obligation under test is: resolve, never throw.
      await turn.steer?.("mid-turn note");
      const outcome = await turn.outcome;
      assert.ok(outcome.kind !== "failed", `steer broke the turn: ${JSON.stringify(outcome)}`);
      await session.dispose();
    },
  },
  {
    id: "session.queue-runs-after-turn",
    requires: ["installation", "session"],
    async run(subject) {
      const session = await subject.startSession();
      if (session.queue === undefined) {
        return;
      }
      const ended: string[] = [];
      session.subscribe((event) => {
        if (event.kind === "turn_ended") {
          ended.push(event.turnId);
        }
      });
      const first = expectTurn(session.prompt("please answer slow-ly"));
      await session.queue.add("and then this");
      await first.outcome;
      const deadline = Date.now() + 30_000;
      while (ended.length < 2 && Date.now() < deadline) {
        await new Promise((resolve) => {
          setTimeout(resolve, 100);
        });
      }
      assert.equal(ended.length, 2, "the queued input runs as its own turn after the active one");
      assert.notEqual(ended[0], ended[1], "the queued turn is a distinct turn");
      await session.dispose();
    },
  },
  {
    // Resume is either real (same id, works after reopen) or a typed loud
    // rejection (pi documents resume as not implemented) — never a silent
    // fresh session pretending to be the old one.
    id: "session.resume-or-loud-rejection",
    requires: ["installation", "session"],
    async run(subject) {
      const first = await subject.startSession();
      const turn = expectTurn(first.prompt("remember me"));
      await turn.outcome;
      const sessionId = first.id;
      await first.dispose();
      const attempt = await subject.startSession({ resume: sessionId }).then(
        (session) => ({ kind: "resumed" as const, session }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      );
      if (attempt.kind === "rejected") {
        assert.match(String(attempt.error), /resume/iu, "a runtime without resume must reject loudly, naming resume");
        return;
      }
      const resumed = attempt.session;
      assert.equal(resumed.id, sessionId, "a resumed session keeps the runtime-native id");
      const again = expectTurn(resumed.prompt("hello again"));
      assert.deepEqual(await again.outcome, { kind: "completed" });
      await resumed.dispose();
    },
  },
];