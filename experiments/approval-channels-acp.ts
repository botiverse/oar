/**
 * APPROVAL CHANNELS over ACP, on the real login: does the runtime's gate ask
 * under `approvals: "ask"`, in what shape, and does a deny hold? One short
 * turn per run, its gated command denied (nothing runs when the gate holds).
 * The claude / codex half, token-free, and what both observed:
 * approval-channels.ts.
 *
 * Run: pnpm tsx experiments/approval-channels-acp.ts <kimi|grok>
 * kimi runs through oar's adapter. grok declares approvals not_enforceable,
 * so its ask session is built here from the switches oar tried (`grok
 * --permission-mode default agent … stdio`, `_meta.yoloMode: false`), to show
 * whether they hold against the user's config.
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runtimes, type RequestRecord, type Session } from "../packages/oar/src/index.js";
import { awaitTurnEnd } from "../packages/oar/src/observe/turns.js";
import { grokAcpProfile } from "../packages/oar/src/runtimes/grok/session.js";
import { acpSession } from "../packages/oar/src/shared/acp/session.js";

const which = process.argv.at(2);

function short(value: unknown, limit = 1200): string {
  const text = value === undefined ? "undefined" : JSON.stringify(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** The first toApp request after `afterSeq`, or null once the turn ended without one (bounded). */
async function firstRequest(session: Session, afterSeq: number): Promise<RequestRecord | null> {
  const { promise, resolve } = Promise.withResolvers<RequestRecord | null>();
  const timer = setTimeout(() => {
    resolve(null);
  }, 180_000);
  const stop = session.rawEvents((record) => {
    if (record.kind === "request" && record.direction === "toApp" && record.body.kind === "native" && record.body.ask !== undefined) {
      resolve(record);
    }
    if (record.kind === "frame" && record.sessionId === session.id && record.body.events.some((event) => event.kind === "turn_ended")) {
      resolve(null);
    }
  }, { sessionId: session.id, afterSeq });
  const request = await promise;
  clearTimeout(timer);
  stop();
  return request;
}

/** One gated command, denied: does the gate ask under approvals "ask", and in what shape? Costs one short turn. */
async function probeAcpLive(id: "grok" | "kimi"): Promise<void> {
  const runtime = runtimes.require(id);
  const installation = await runtime.installation?.();
  if (installation?.kind !== "available") {
    console.log(`${id}: not available`);
    return;
  }
  const work = await mkdtemp(path.join(tmpdir(), `oar-approval-${id}-`));
  const target = path.join(work, "oar-probe-file");
  // grok declares approvals not_enforceable, so its ask session is built by
  // hand here: the switches oar tried, which this probe shows do not hold.
  const start = id === "grok"
    ? acpSession({
      ...grokAcpProfile,
      args: ["--permission-mode", "default", "agent", "--no-leader", "stdio"],
      sessionMeta: () => ({ yoloMode: false }),
      capabilities: { ...grokAcpProfile.capabilities, approvals: { kind: "supported" } },
    })
    : runtime.session;
  const session = await start(installation, { cwd: work, approvals: "ask" });
  try {
    const prompt = await session.prompt(`Use your shell tool to run exactly this command, then reply with the single word done: touch ${target}`);
    const request = await firstRequest(session, prompt.seq);
    console.log(`${id}: first ask ${request === null ? "none: the turn ended unasked" : JSON.stringify(request.body)}`);
    const before = session.records().filter((record) => record.kind === "frame" && record.seq > prompt.seq && record.seq < (request?.seq ?? 0));
    console.log(`${id}: frames before it ${before.map((record) => (record.kind === "frame" ? `${record.body.type} ${short(record.body.native, 800)}` : "")).join("\n  ")}`);
    if (request !== null) {
      const answer = await session.answer(request.id, { kind: "deny" });
      console.log(`${id}: deny → ${answer.kind}; answered ${short(session.records().find((record) => record.kind === "response" && record.requestId === request.id)?.body)}`);
      // Deny whatever else it asks, so nothing runs.
      session.rawEvents((record) => {
        if (record.kind === "request" && record.direction === "toApp" && record.body.kind === "native" && record.body.ask?.kind === "tool_approval") {
          void session.answer(record.id, { kind: "deny" });
        }
      }, { sessionId: session.id, afterSeq: session.records().at(-1)?.seq ?? prompt.seq });
    }
    const outcome = await awaitTurnEnd(session, prompt.seq);
    const text = session.records().flatMap((record) => (record.kind === "frame" ? record.body.events : [])).flatMap((event) => (event.kind === "text_delta" ? [event.text] : [])).join("");
    console.log(`${id}: turn ${short(outcome)}; file created: ${String(existsSync(target))}; said ${short(text.slice(-300))}`);
  } finally {
    await session.dispose();
    await rm(work, { recursive: true, force: true });
  }
}


if (which === "grok" || which === "kimi") {
  await probeAcpLive(which);
} else {
  console.log("usage: pnpm tsx experiments/approval-channels-acp.ts <kimi|grok>");
}
