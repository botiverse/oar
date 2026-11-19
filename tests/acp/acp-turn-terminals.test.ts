/* oxlint-disable typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion, eslint/max-statements, unicorn/consistent-function-scoping -- Minimal stand-ins for the kernel, records and turns this module reads a few fields of. */
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import type { RawEvent, RequestRecord, ResponseBody } from "../../packages/oar/src/contracts/session.js";
import type { SessionKernel } from "../../packages/oar/src/shared/session-kernel.js";
import { acpTurnTerminals } from "../../packages/oar/src/shared/acp/turn-terminals.js";
import type { ActiveTurn } from "../../packages/oar/src/shared/acp/turns.js";

/** A stand-in kernel: the observer the module registers, and the responses it records. */
function harness() {
  let observe: (event: RawEvent) => void = () => {};
  const responses: { readonly requestId: string; readonly body: ResponseBody }[] = [];
  const ended: (readonly string[])[] = [];
  let seq = 0;
  const kernel = {
    sessionId: "root",
    rawEvents: (observer: (event: RawEvent) => void) => { observe = observer; return () => {}; },
    respond: (requestId: string, body: ResponseBody) => { responses.push({ requestId, body }); },
  } as unknown as SessionKernel;
  const state = { active: null as ActiveTurn | null };
  const turns = acpTurnTerminals(true, kernel, { end: async (ids) => { ended.push(ids); await Promise.resolve(); return { signalled: ids.length }; } }, () => state.active);
  const emit = (event: object): void => { seq += 1; observe({ seq, sessionId: "root", ...event } as unknown as RawEvent); };
  const terminal = (terminalId: string, sessionId = "root"): void => {
    const id = `t-${terminalId}`;
    emit({ kind: "request", sessionId, direction: "toApp", id, body: { kind: "native", type: "terminal/create", native: {} } });
    emit({ kind: "response", sessionId, requestId: id, body: { kind: "answered", native: { terminalId } } });
  };
  const begin = (kind: "compact" | "prompt" = "prompt"): ActiveTurn => { const turn = { since: seq, request: { body: { kind } } } as unknown as ActiveTurn; state.active = turn; return turn; };
  const close = (kind: "completed" | "aborted" = "aborted"): void => { state.active = null; emit({ kind: "frame", body: { type: "session/prompt", native: {}, events: [{ kind: "turn_ended", outcome: { kind } }] } }); };
  return { turns, terminal, begin, close, responses, ended, emit };
}
const request = (id: string): RequestRecord => ({ id } as unknown as RequestRecord);
const settled = async (): Promise<void> => { await delay(0); };

test("an accepted abort ends only the terminals its turn requested, after the turn closes", async () => {
  const h = harness();
  h.terminal("earlier");
  const turn = h.begin();
  h.terminal("this-turn");
  const claim = h.turns.aborting(turn, request("abort-1"));
  h.close();
  claim.accepted();
  await settled();
  expect(h.ended).toEqual([["this-turn"]]);
  expect(h.responses).toEqual([{ requestId: "abort-1", body: { kind: "cleanup", result: { kind: "completed", signalled: 1 } } }]);
});

test("a turn that ends on its own while the abort is refused stops nothing and records no cleanup", async () => {
  const h = harness();
  const turn = h.begin();
  h.terminal("running");
  const claim = h.turns.aborting(turn, request("abort-1"));
  h.close();
  claim.refused();
  await settled();
  expect(h.ended).toEqual([]);
  expect(h.responses).toEqual([]);
});

test("with no abort waiting, a closed turn's terminals are forgotten; a later abort sees only its own", async () => {
  const h = harness();
  h.begin();
  h.terminal("first-turn");
  h.close();
  const second = h.begin();
  h.terminal("second-turn");
  const claim = h.turns.aborting(second, request("abort-2"));
  claim.accepted();
  h.close();
  await settled();
  expect(h.ended).toEqual([["second-turn"]]);
});

test("terminals requested after the aborted turn closed are not its own, even before the abort's answer arrives", async () => {
  const h = harness();
  const turn = h.begin();
  h.terminal("this-turn");
  const claim = h.turns.aborting(turn, request("abort-1"));
  h.close();
  h.begin();
  h.terminal("next-turn");
  claim.accepted();
  await settled();
  expect(h.ended).toEqual([["this-turn"]]);
});

test("accepted cancellation preserves terminals when the native turn completed", async () => {
  const h = harness();
  const turn = h.begin();
  h.terminal("root-terminal");
  h.turns.aborting(turn, request("cancel")).accepted();
  h.close("completed");
  await settled();
  expect(h.ended).toEqual([]);
});

test("a root turn can stop only its own terminal", async () => {
  const h = harness();
  const turn = h.begin();
  h.terminal("root-terminal");
  h.terminal("child-terminal", "child");
  h.turns.aborting(turn, request("cancel")).accepted();
  h.close();
  await settled();
  expect(h.ended).toEqual([["root-terminal"]]);
});

test("a compact cancellation cannot claim terminals from the next prompt", async () => {
  const h = harness();
  const compact = h.begin("compact");
  h.turns.aborting(compact, request("cancel")).accepted();
  h.emit({ kind: "frame", body: { events: [{ kind: "compaction_ended", outcome: "aborted" }] } });
  h.begin();
  h.terminal("next-turn");
  h.close("completed");
  await settled();
  expect(h.ended).toEqual([]);
});

test("shared fallback has a single cleanup reporter for its abort request", () => {
  const h = harness();
  const turn = h.begin();
  h.turns.aborting(turn, request("cancel")).accepted();
  h.emit({ kind: "response", requestId: "cancel", body: { kind: "released", reason: "abort_fallback" } });
  expect(h.responses).toEqual([]);
});
