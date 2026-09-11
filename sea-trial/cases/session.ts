import assert from "node:assert/strict";
import type { ControlResult, RequestRecord, ResponseRecord, Session, SessionRecord, TurnOutcome } from "../../packages/oar/src/contracts/session.js";
import { awaitTurnEnd, turnEndAfter } from "../../packages/oar/src/observe/turns.js";
import type { TrialCase } from "../harness/runner.js";

/** Prompt and insist the runtime accepted it. */
async function accepted(session: Session, input: string): Promise<ControlResult> {
  const result = await session.prompt(input);
  assert.ok(result.response.body.kind === "accepted", `prompt ${JSON.stringify(input)} was not accepted: ${JSON.stringify(result.response.body)}`);
  return result;
}

async function runTurn(session: Session, input: string): Promise<TurnOutcome> {
  const result = await accepted(session, input);
  return awaitTurnEnd(session, result.request.seq);
}

/** Root-agent records of one turn: from the prompt request through the runtime's turn end. */
function turnRecords(records: readonly SessionRecord[], result: ControlResult): readonly SessionRecord[] {
  const start = records.findIndex((record) => record.seq === result.request.seq);
  assert.ok(start !== -1, "the prompt request is in the retained log");
  const slice: SessionRecord[] = [];
  for (const record of records.slice(start)) {
    slice.push(record);
    if (record.agentPath.length === 0 && record.kind === "event" && record.body.views.some((view) => view.kind === "turn_ended")) {
      break;
    }
  }
  return slice;
}

function rootTurnEnds(records: readonly SessionRecord[]): readonly SessionRecord[] {
  return records.filter((record) =>
    record.agentPath.length === 0 && record.kind === "event" && record.body.views.some((view) => view.kind === "turn_ended"));
}

export const sessionCases: readonly TrialCase[] = [
  {
    // The contract's promise in one case: the turn's start is the prompt request, its
    // end is the runtime's own turn_ended event, every record self-attributes
    // (sessionId + agentPath), every event carries the runtime's frame
    // verbatim, and seq is the one total order.
    id: "session.framing-and-attribution",
    requires: ["installation", "session"],
    async run(subject) {
      const session = await subject.startSession();
      const live: SessionRecord[] = [];
      session.subscribe((record) => {
        live.push(record);
      });
      const result = await accepted(session, "hello");
      const outcome = await awaitTurnEnd(session, result.request.seq);
      assert.deepEqual(outcome, { kind: "completed" });
      const turn = turnRecords(session.records(), result);
      assert.equal(turn[0]?.kind, "request", "the turn starts with the prompt request");
      const accept = turn.find((record) => record.kind === "response" && record.requestId === result.request.id);
      assert.ok(accept?.kind === "response" && accept.body.kind === "accepted", "the accept answers the request inside the turn");
      const last = turn.at(-1);
      assert.ok(last?.kind === "event" && last.body.views.some((view) => view.kind === "turn_ended"), "the turn ends with the runtime's own turn_ended event");
      for (const [index, record] of turn.entries()) {
        if (record.agentPath.length === 0) {
          assert.equal(record.sessionId, session.id, "root records carry the session id");
        }
        if (record.kind === "event") {
          assert.ok(record.body.type.length > 0, "every event names its runtime-native type");
          assert.notEqual(record.body.native, undefined, "every event carries the runtime's frame verbatim");
        }
        if (index > 0) {
          assert.ok(record.seq > (turn[index - 1]?.seq ?? Number.NaN), "seq is strictly increasing");
        }
      }
      assert.deepEqual(live.map((record) => record.seq), session.records().filter((record) => record.seq >= (live[0]?.seq ?? 0)).map((record) => record.seq), "live delivery and the retained log agree");
      await session.dispose();
    },
  },
  {
    id: "session.single-active-turn",
    requires: ["installation", "session"],
    async run(subject) {
      const session = await subject.startSession();
      const first = await accepted(session, "one");
      const second = await session.prompt("two");
      assert.deepEqual(second.response.body, { kind: "rejected", reason: "busy" }, "second prompt during an active turn was not rejected busy");
      await awaitTurnEnd(session, first.request.seq);
      await runTurn(session, "three");
      await session.dispose();
    },
  },
  {
    // Race-honest by design: on a real runtime the turn may complete before
    // the interrupt lands, and the runtime's truth wins. What every runtime
    // MUST honor: the abort request is recorded and answered; the turn ends
    // aborted or completed (never failed); a late abort is rejected, never an
    // error. The strong "abort actually aborts a long turn" claim lives in
    // the live experiments.
    id: "session.abort-settles-and-is-idempotent",
    requires: ["installation", "session"],
    async run(subject) {
      const session = await subject.startSession();
      const started = await accepted(session, "slow");
      const abort = await session.abort();
      assert.ok(abort.response.requestId === abort.request.id && abort.request.body.kind === "abort", "abort is a recorded request with its response");
      const outcome = await awaitTurnEnd(session, started.request.seq);
      assert.ok(outcome.kind !== "failed", `abort produced a failure: ${JSON.stringify(outcome)}`);
      const late = await session.abort();
      assert.equal(late.response.body.kind, "rejected", "a late abort is rejected, not an error");
      assert.equal(turnEndAfter(session.records(), started.request.seq)?.kind, outcome.kind, "a late abort changed nothing");
      await session.dispose();
    },
  },
  {
    id: "session.steer-after-end",
    requires: ["installation", "session"],
    async run(subject) {
      const session = await subject.startSession();
      await runTurn(session, "hello");
      const late = await session.steer("too late");
      assert.equal(late.response.body.kind, "rejected", "steer with no active turn must be rejected");
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
      session.subscribe((record) => {
        seen.push(record.kind === "event" ? record.body.views.map((view) => view.kind).join("+") : `${record.kind}:${record.kind === "request" ? record.body.kind : record.body.kind}`);
      });
      const outcome = await runTurn(session, "hello");
      assert.deepEqual(outcome, { kind: "completed" }, "a throwing observer affected the run");
      assert.ok(seen.includes("request:prompt") && seen.some((kind) => kind.includes("turn_ended")), "a throwing observer starved a later observer");
      await session.dispose();
    },
  },
  {
    id: "session.multi-turn-conversation",
    requires: ["installation", "session"],
    async run(subject) {
      const session = await subject.startSession();
      const results: ControlResult[] = [];
      for (const input of ["one", "two", "three"]) {
        const result = await accepted(session, input);
        results.push(result);
        assert.deepEqual(await awaitTurnEnd(session, result.request.seq), { kind: "completed" });
      }
      const records = session.records();
      const prompts = records.filter((record) => record.kind === "request" && record.body.kind === "prompt");
      assert.equal(prompts.length, 3, "three prompts are three request records");
      for (const [index, result] of results.entries()) {
        const ends = rootTurnEnds(turnRecords(records, result));
        assert.equal(ends.length, 1, `turn ${String(index + 1)} ends exactly once`);
      }
      for (const [index, record] of records.entries()) {
        if (index > 0) {
          assert.ok(record.seq > (records[index - 1]?.seq ?? Number.NaN), "seq stays strictly increasing across turns");
        }
      }
      await session.dispose();
    },
  },
  {
    // Race-honest: on a real runtime the turn may end before the steer lands,
    // so both accepted and rejected are lawful. What every runtime MUST
    // honor: a mid-turn steer never throws, is recorded with its response,
    // never corrupts the turn, and the turn still ends without failing.
    // Strong acceptance/visibility claims live in the live experiments.
    id: "session.steer-mid-turn",
    requires: ["installation", "session"],
    async run(subject) {
      const session = await subject.startSession();
      const started = await accepted(session, "please answer slow-ly");
      const steer = await session.steer("mid-turn note");
      assert.equal(steer.request.body.kind, "steer");
      assert.ok(steer.response.body.kind === "accepted" || steer.response.body.kind === "rejected");
      const outcome = await awaitTurnEnd(session, started.request.seq);
      assert.ok(outcome.kind !== "failed", `steer broke the turn: ${JSON.stringify(outcome)}`);
      await session.dispose();
    },
  },
  {
    id: "session.queue-runs-after-turn",
    requires: ["installation", "session"],
    async run(subject) {
      const session = await subject.startSession();
      if (session.capabilities.queue === null) {
        const refused = await session.queue("held");
        assert.equal(refused.response.body.kind, "rejected", "a runtime without a queue must reject, not silently drop");
        await session.dispose();
        return;
      }
      const first = await accepted(session, "please answer slow-ly");
      const queued = await session.queue("and then this");
      assert.equal(queued.response.body.kind, "accepted");
      await awaitTurnEnd(session, first.request.seq);
      const deadline = Date.now() + 30_000;
      while (rootTurnEnds(session.records()).length < 2 && Date.now() < deadline) {
        await new Promise((resolve) => {
          setTimeout(resolve, 100);
        });
      }
      assert.equal(rootTurnEnds(session.records()).length, 2, "the queued input runs as its own turn after the active one");
      await session.dispose();
    },
  },
  {
    // The cursor: reconnecting with {sessionId, afterSeq} replays exactly the
    // retained records after that position and then continues live — no
    // loss, no duplication, for the lifetime of this adapter process.
    id: "session.cursor-replays-without-loss-or-duplication",
    requires: ["installation", "session"],
    async run(subject) {
      const session = await subject.startSession();
      const first = await accepted(session, "one");
      await awaitTurnEnd(session, first.request.seq);
      const afterSeq = first.request.seq;
      const seen: number[] = [];
      session.subscribe((record) => {
        seen.push(record.seq);
      }, { sessionId: session.id, afterSeq });
      const expectedReplay = session.records().filter((record) => record.seq > afterSeq).map((record) => record.seq);
      assert.deepEqual([...seen], expectedReplay, "replay delivers exactly the retained records after the cursor");
      await runTurn(session, "two");
      const expectedAll = session.records().filter((record) => record.seq > afterSeq).map((record) => record.seq);
      assert.deepEqual(seen, expectedAll, "live records continue the replayed sequence without gaps or repeats");
      await session.dispose();
    },
  },
  {
    // Death is a recorded fact: dispose is a request record, and the outcome
    // oar observed (the process exit, or the in-process release) answers it.
    id: "session.dispose-is-recorded",
    requires: ["installation", "session"],
    async run(subject) {
      const session = await subject.startSession();
      await runTurn(session, "hello");
      await session.dispose();
      const records = session.records();
      const dispose = records.find((record): record is RequestRecord => record.kind === "request" && record.body.kind === "dispose");
      assert.ok(dispose !== undefined, "dispose is a request record");
      const answer = records.find((record): record is ResponseRecord => record.kind === "response" && record.requestId === dispose.id);
      assert.ok(answer !== undefined && (answer.body.kind === "exited" || answer.body.kind === "accepted"), "the observed release answers the dispose request");
      const after = await session.prompt("after dispose");
      assert.equal(after.response.body.kind, "rejected", "a disposed session rejects further control");
      await session.dispose();
    },
  },
  {
    // Resume is either real (same id, works after reopen) or a typed loud
    // rejection — never a silent fresh session pretending to be the old one.
    id: "session.resume-or-loud-rejection",
    requires: ["installation", "session"],
    async run(subject) {
      const first = await subject.startSession();
      await runTurn(first, "remember me");
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
      assert.deepEqual(await runTurn(resumed, "hello again"), { kind: "completed" });
      await resumed.dispose();
    },
  },
];
