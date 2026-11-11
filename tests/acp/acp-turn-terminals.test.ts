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
    rawEvents: (observer: (event: RawEvent) => void) => { observe = observer; return () => {}; },
    respond: (requestId: string, body: ResponseBody) => { responses.push({ requestId, body }); },
  } as unknown as SessionKernel;
  const state = { active: null as ActiveTurn | null };
  const turns = acpTurnTerminals(true, kernel, { end: async (ids) => { ended.push(ids); await Promise.resolve(); return { signalled: ids.length }; } }, () => state.active);
  const emit = (event: object): void => { seq += 1; observe({ seq, ...event } as unknown as RawEvent); };
  const terminal = (terminalId: string): void => {
    const id = `t-${terminalId}`;
    emit({ kind: "request", direction: "toApp", id, body: { kind: "native", type: "terminal/create", native: {} } });
    emit({ kind: "response", requestId: id, body: { kind: "answered", native: { terminalId } } });
  };
  const begin = (): ActiveTurn => { const turn = { since: seq } as unknown as ActiveTurn; state.active = turn; return turn; };
  const close = (): void => { state.active = null; emit({ kind: "frame", body: { type: "session/prompt", native: {}, events: [{ kind: "turn_ended", outcome: { kind: "aborted" } }] } }); };
  return { turns, terminal, begin, close, responses, ended };
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
