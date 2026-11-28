#!/usr/bin/env node
/* oxlint-disable eslint/max-statements, eslint/no-continue, import/no-nodejs-modules, typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument, typescript/no-unnecessary-condition, typescript/strict-boolean-expressions -- Standalone untyped fixture executable. */
// `bottega serve` as far as OAR's adapter sees it (bottega/src/serve.ts,
// protocol 1), with the turn scripted by the input's own text:
//   "hold"    the turn stays open until a steer saying "release", or a cancel
//   "decline" a host's event starts no turn and comes back as input_dropped
//   "fail" / "cap"  the turn ends failed / capped
//   "refuse"  the prompt itself is refused, with bottega's own error
// Anything else is one step and an echo. FAKE_BOTTEGA_PROTOCOL changes the
// protocol it announces; FAKE_BOTTEGA_ROUTE is the route a resume reports;
// FAKE_BOTTEGA_ANONYMOUS_DROP gives a declined event back without its inputId.
import { createInterface } from "node:readline";

if (process.argv[2] === "--version") { console.log("0.0.0-fake"); process.exit(0); }

const send = (message) => { process.stdout.write(`${JSON.stringify(message)}\n`); };
const fail = (id, code, message) => { send({ type: "response", id, error: { code, message } }); };
let session = null;
let turn = null;
let step = 0;
let turns = 0;

function end(outcome, reason) {
  if (turn === null) { return; }
  const { inputIds } = turn;
  turn = null;
  send({ type: "turn_ended", step, outcome, ...(reason === undefined ? {} : { reason }), inputIds });
}

function begin(text, inputId, origin) {
  const event = origin?.kind !== undefined && origin.kind !== "user";
  if (event && text.includes("decline")) {
    const named = inputId !== undefined && process.env.FAKE_BOTTEGA_ANONYMOUS_DROP === undefined;
    setTimeout(() => { send({ type: "input_dropped", ...(named ? { inputId } : {}), reason: "raft: decline — not waking the agent: you stopped the agent" }); }, 20);
    return;
  }
  turn = { inputIds: inputId === undefined ? [] : [inputId] };
  turns += 1;
  setTimeout(() => {
    if (event) { send({ type: "note", text: `(woken by ${origin.source ?? "host"}: ${text})` }); }
    else { send({ type: "said", id: `m${String(turns * 2 - 1)}`, step, who: "user", text, ...(inputId === undefined ? {} : { inputId }) }); }
    send({ type: "turn_started", step, ...(inputId === undefined ? {} : { inputId }) });
    step += 1;
    send({ type: "action", id: `s${String(step)}.0`, step, tool: "unsent", args: "", note: "thinking it over" });
    send({ type: "action", id: `s${String(step)}.1`, step, tool: "files_read", args: "{\"path\":\"README.md\"}", note: "w3: 12 lines" });
    send({ type: "step", step, provider: session.provider, model: session.model, usage: { input: 100, output: 10, cacheRead: 40, cacheWrite: 5, cost: 0.001 }, promptTokens: 140, contextBudget: 1000 });
    if (text.includes("hold")) { return; }
    send({ type: "said", id: `m${String(turns * 2)}`, step, who: "agent", text: `echo:${text}` });
    if (text.includes("fail")) { end("failed", "the agent hit an error: inference error: scripted"); }
    else if (text.includes("cap")) { end("capped", "stopped at 30 steps, the most one message gives it, before it finished its turn"); }
    else { end("completed"); }
  }, 10);
}

send({ type: "ready", protocol: Number(process.env.FAKE_BOTTEGA_PROTOCOL ?? 1), version: "0.0.0-fake" });
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, ...fields } = JSON.parse(line);
  if (method === "open" || method === "resume") {
    if (method === "resume" && fields.sessionId === "missing") { fail(id, "session_not_found", `no session 'missing' for ${String(fields.cwd)}`); continue; }
    if (fields.thinking === "galactic") { fail(id, "unsupported_thinking", "no thinking level 'galactic'"); continue; }
    const [provider = "fake", model = "fake-1"] = method === "resume" ? (process.env.FAKE_BOTTEGA_ROUTE ?? "fake/fake-1").split("/") : [fields.provider, fields.model];
    session = { sessionId: method === "resume" ? fields.sessionId : "1112-0900-fake", provider, model };
    send({ type: "response", id, result: { ...session, root: `/sessions/${session.sessionId}`, thinking: fields.thinking ?? "medium", apps: ["chat"], asked: { method, ...fields } } });
  } else if (method === "prompt") {
    if (turn !== null) { fail(id, "busy", "busy"); continue; }
    if (fields.text.includes("refuse")) { fail(id, "invalid_request", "scripted refusal"); continue; }
    send({ type: "response", id, result: { as: fields.origin?.kind !== undefined && fields.origin.kind !== "user" ? "event" : "line" } });
    begin(fields.text, fields.inputId, fields.origin);
  } else if (method === "steer") {
    if (turn === null) { fail(id, "no_active_turn", "no active turn"); continue; }
    send({ type: "response", id, result: { as: "line" } });
    if (fields.inputId !== undefined) { turn.inputIds.push(fields.inputId); }
    send({ type: "said", id: `steer-${String(id)}`, step, who: "user", text: fields.text, ...(fields.inputId === undefined ? {} : { inputId: fields.inputId }) });
    if (fields.text.includes("release")) { end("completed"); }
  } else if (method === "cancel") {
    if (turn === null) { fail(id, "no_active_turn", "no active turn"); continue; }
    send({ type: "response", id, result: {} });
    end("aborted");
  } else if (method === "dispose") {
    send({ type: "response", id, result: {} });
    process.exit(0);
  } else {
    fail(id, "unknown_method", `no method '${String(method)}'`);
  }
}
