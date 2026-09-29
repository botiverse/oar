import { expect, test } from "vitest";
import type { ControlOutcome, Session } from "../../packages/oar/src/contracts/session.js";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { GROK_APPROVALS, grokSession } from "../../packages/oar/src/runtimes/grok/session.js";
import { kimiModeFor } from "../../packages/oar/src/runtimes/kimi/session.js";
import { acpAsk } from "../../packages/oar/src/shared/acp/approvals.js";
import { acpSession } from "../../packages/oar/src/shared/acp/session.js";
import { profile, tail } from "../fixtures/acp-session-support.js";

/*
 * ACP under approvals "ask": a session/request_permission is a toApp request
 * with what it asks, and its JSON-RPC reply waits for Session.answer; an
 * abort answers the waiting ones `cancelled`, as ACP requires of a client
 * that cancels a turn. Driven through the fake agent (fake-acp-agent.mjs),
 * whose "permission" prompt asks with allow_once / allow_always / reject_once.
 */

const installation = { kind: "available", via: "executable", command: process.execPath } as const;

async function asking(): Promise<Session> {
  return acpSession(profile())(installation, { cwd: process.cwd(), approvals: "ask" });
}

/** Resolves once the stream holds a toApp request; its id. */
async function asked(session: Session): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>();
  const stop = session.rawEvents((record) => {
    if (record.kind === "request" && record.direction === "toApp") {
      resolve(record.id);
    }
  }, { sessionId: session.id, afterSeq: -1 });
  const id = await promise;
  stop();
  return id;
}

function codeOf(outcome: ControlOutcome): string {
  return outcome.kind === "rejected" ? outcome.code : outcome.kind;
}

function said(session: Session): string[] {
  return session.records().flatMap((record) => (record.kind === "frame" ? record.body.events : [])).flatMap((event) => (event.kind === "text_delta" ? [event.text] : []));
}

function opened(current: string): Record<string, unknown> {
  return { modes: { currentModeId: current, availableModes: ["default", "plan", "auto", "yolo"].map((id) => ({ id })) } };
}

test("a permission request waits for the host with what it asks: the tool call, allow and deny", async () => {
  const session = await asking();
  await session.prompt("permission");
  const requestId = await asked(session);
  expect(session.status().value.awaiting).toEqual([requestId]);
  const request = session.records().find((record) => record.kind === "request" && record.id === requestId);
  expect(request?.kind === "request" && request.body.kind === "native" ? request.body.ask : null).toEqual({
    kind: "tool_approval",
    tool: "execute",
    callId: "permission-tool",
    title: "Permission fixture",
    choices: ["allow", "deny"],
    denyMessage: false,
  });
  await session.dispose();
});

// oxlint-disable-next-line eslint/max-statements -- the refused decisions, the allow, and the turn it lets go on are one scenario.
test("allow picks the allow_once option and the turn goes on; ACP has no session scope and no deny message", async () => {
  const session = await asking();
  const prompt = await session.prompt("permission");
  const requestId = await asked(session);
  const forSession = await session.answer(requestId, { kind: "allow", scope: "session" });
  const message = await session.answer(requestId, { kind: "deny", message: "no" });
  const allowed = await session.answer(requestId, { kind: "allow" });
  expect([codeOf(forSession), codeOf(message), codeOf(allowed)]).toEqual(["unsupported", "unsupported", "accepted"]);
  expect(await awaitTurnEnd(session, prompt.seq)).toEqual({ kind: "completed" });
  expect(tail(session, prompt.seq - 1)).toEqual([
    "request prompt",
    "response accepted",
    "toApp session/request_permission",
    "request answer",
    "response rejected",
    "request answer",
    "response rejected",
    "request answer",
    "response answered",
    "response accepted",
    "event agent_message_chunk → text:permission:once",
    "event session/prompt → turn_ended:completed",
  ]);
  await session.dispose();
});

test("deny picks reject_once; a native reply picks any option", async () => {
  const denied = await asking();
  const first = await denied.prompt("permission");
  const deny = await denied.answer(await asked(denied), { kind: "deny" });
  await awaitTurnEnd(denied, first.seq);
  const always = await asking();
  const second = await always.prompt("permission");
  const native = await always.answer(await asked(always), { kind: "native", native: { outcome: { outcome: "selected", optionId: "always" } } });
  await awaitTurnEnd(always, second.seq);
  expect([codeOf(deny), codeOf(native), said(denied), said(always)]).toEqual(["accepted", "accepted", ["permission:reject"], ["permission:always"]]);
  await Promise.all([denied.dispose(), always.dispose()]);
});

// oxlint-disable-next-line eslint/max-statements -- the abort, the protocol's cancelled answer and the late answer are one scenario.
test("an abort answers the waiting request cancelled, as ACP requires; a later answer finds it answered", async () => {
  const session = await asking();
  const prompt = await session.prompt("permission");
  const requestId = await asked(session);
  const abort = await session.abort();
  expect(abort.kind).toBe("accepted");
  expect(await awaitTurnEnd(session, prompt.seq)).toEqual({ kind: "aborted" });
  const answered = session.records().find((record) => record.kind === "response" && record.requestId === requestId);
  expect(answered?.kind === "response" ? answered.body : null).toEqual({ kind: "answered", native: { outcome: { outcome: "cancelled" } } });
  const late = await session.answer(requestId, { kind: "allow" });
  expect([codeOf(late), session.status().value.awaiting]).toEqual(["already_answered", undefined]);
  await session.dispose();
});

test("YOLO still answers a permission request itself; a host answer then finds it answered", async () => {
  const session = await acpSession(profile())(installation, { cwd: process.cwd() });
  const prompt = await session.prompt("permission");
  await awaitTurnEnd(session, prompt.seq);
  const late = await session.answer(await asked(session), { kind: "allow" });
  expect(codeOf(late)).toBe("already_answered");
  await session.dispose();
});

test("grok declares approvals not enforceable and refuses an ask session before spawning anything", async () => {
  await expect(grokSession({ kind: "available", via: "executable", command: "/nonexistent/grok" }, { cwd: "/w", approvals: "ask" })).rejects.toThrow(
    `approvals "ask" is unsupported here: ${GROK_APPROVALS.reason}`,
  );
  expect(GROK_APPROVALS).toMatchObject({ kind: "unsupported", code: "not_enforceable" });
});

test("kimi's gate is its default mode: set when the session opens in another, required to exist", () => {
  expect([
    kimiModeFor({ cwd: "/w" }, opened("default")),
    kimiModeFor({ cwd: "/w", approvals: "ask" }, opened("default")),
    kimiModeFor({ cwd: "/w", approvals: "ask" }, opened("yolo")),
  ]).toEqual(["yolo", null, "default"]);
  expect(() => kimiModeFor({ cwd: "/w", approvals: "ask" }, { modes: { availableModes: [{ id: "yolo" }] } })).toThrow('kimi offers no "default" permission mode');
});

test("where the profile knows allow_always is session-scoped (kimi), allow for the session picks it", async () => {
  const session = await acpSession(profile({ allowAlwaysIsSession: true }))(installation, { cwd: process.cwd(), approvals: "ask" });
  const prompt = await session.prompt("permission");
  const requestId = await asked(session);
  const request = session.records().find((record) => record.kind === "request" && record.id === requestId);
  expect(request?.kind === "request" && request.body.kind === "native" ? request.body.ask?.choices : null).toEqual(["allow", "allow_session", "deny"]);
  const granted = await session.answer(requestId, { kind: "allow", scope: "session" });
  await awaitTurnEnd(session, prompt.seq);
  expect([codeOf(granted), said(session)]).toEqual(["accepted", ["permission:always"]]);
  await session.dispose();
});

// The request kimi 2.0.0 sent for a Bash `touch` (experiments/approval-channels-acp.ts kimi, 2026-09-29), path shortened.
const KIMI_REQUEST: Parameters<typeof acpAsk>[0] = {
  sessionId: "session_1",
  toolCall: {
    toolCallId: "0:tool_1",
    title: "Bash",
    content: [{ type: "content", content: { type: "text", text: "Requesting approval to Running: touch /tmp/oar-probe-file" } }],
  },
  options: [
    { optionId: "approve_once", name: "Approve once", kind: "allow_once" },
    { optionId: "approve_always", name: "Approve for this session", kind: "allow_always" },
    { optionId: "reject", name: "Reject", kind: "reject_once" },
  ],
};

test("acpAsk reads kimi's request: the title as the tool, its description as the reason, its options as choices", () => {
  expect([acpAsk(KIMI_REQUEST), acpAsk(KIMI_REQUEST, { allowAlwaysIsSession: true }).choices]).toEqual([
    {
      kind: "tool_approval",
      tool: "Bash",
      callId: "0:tool_1",
      title: "Bash",
      reason: "Requesting approval to Running: touch /tmp/oar-probe-file",
      choices: ["allow", "deny"],
      denyMessage: false,
    },
    ["allow", "allow_session", "deny"],
  ]);
});
