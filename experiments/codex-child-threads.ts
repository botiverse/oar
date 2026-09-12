/**
 * LIVE PROBE: does the codex app-server deliver OTHER threads' notifications
 * on the parent thread's connection, and how does the running binary spell
 * the collaboration item fields?
 *
 * Through the contract path (runtimes/codex/session.ts): one session, one
 * prompt that asks the model to spawn a sub-agent, then every record is
 * printed with its method, envelope sessionId (a child thread id means the
 * projection derived a child session), the Thread's `parentThreadId` on
 * `thread/started`, and the collab item fields on item/started|completed.
 * The session graph is printed at the end.
 *
 * OBSERVED: see the row in experiments/README.md and docs/runtimes/codex.md
 * ("Native child agents").
 *
 * Run: pnpm tsx experiments/codex-child-threads.ts   (requires logged-in `codex`
 * with the `multi_agent` feature enabled; `codex features list` shows it)
 */
import { awaitTurnEnd, codexRuntime, type SessionRecord, type TurnOutcome } from "../packages/oar/src/index.js";

const COLLAB = new Set(["collabAgentToolCall", "collabToolCall", "subAgentActivity"]);
function asRec(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

const installation = await codexRuntime.installation();
if (installation.kind !== "available") {
  throw new Error("codex is not available on this machine");
}
const session = await codexRuntime.session(installation, { cwd: process.cwd() });
process.stdout.write(`root thread ${session.id}\n`);

const methods = new Map<string, number>();
const threadIds = new Set<string>();
session.subscribe((record: SessionRecord) => {
  const tag = record.sessionId === session.id ? "root" : `child:${record.sessionId.slice(0, 8)}`;
  if (record.kind !== "event") {
    process.stdout.write(`${record.seq} ${tag} ${record.kind} ${record.body.kind}\n`);
    return;
  }
  const method = record.body.type;
  methods.set(method, (methods.get(method) ?? 0) + 1);
  threadIds.add(record.sessionId);
  const params = asRec(record.body.native) ?? {};
  let extra = "";
  if (method === "thread/started" || method === "thread/status/changed" || method === "thread/closed") {
    const thread = asRec(params.thread);
    extra = JSON.stringify({ threadId: params.threadId, id: thread?.id, parentThreadId: thread?.parentThreadId, status: thread?.status ?? params.status });
  } else if (method === "item/started" || method === "item/completed") {
    const item = asRec(params.item);
    const type = typeof item?.type === "string" ? item.type : "?";
    extra = COLLAB.has(type)
      ? JSON.stringify(item)
      : type;
  } else if (method === "turn/completed") {
    extra = JSON.stringify({ status: asRec(params.turn)?.status });
  } else if (method === "thread/tokenUsage/updated") {
    const total = asRec(asRec(params.tokenUsage)?.total);
    extra = JSON.stringify({ input: total?.inputTokens, output: total?.outputTokens });
  } else if (method === "error") {
    extra = JSON.stringify(params.error);
  }
  if (method !== "item/agentMessage/delta" && method !== "rawResponseItem/completed") {
    process.stdout.write(`${record.seq} ${tag} ${method} ${extra}\n`);
  }
});

const prompt = await session.prompt([
  "You have a sub-agent (spawn_agent / collaboration) tool. Spawn exactly one sub-agent",
  "whose only job is to run the shell command `echo CHILD-OK-7731` and report the printed",
  "line back to you. Wait for it to finish, then reply with exactly the line it reported.",
  "Do not run the command yourself.",
].join(" "));
if (prompt.response.body.kind !== "accepted") {
  throw new Error(`prompt not accepted: ${JSON.stringify(prompt.response.body)}`);
}
// Two waits, on purpose. `awaitTurnEnd` is the shipped observe fold, scoped
// to the root session since 2026-09-11 (before that a derived child session's
// turn_ended (sessionId = child thread, agentPath []) satisfied it, and on
// 0.149.0 the child's turn/completed arrived first). The second wait is an
// independent hand-rolled check for the ROOT thread's own turn/completed. Both
// are printed so any disagreement is on the record.
const observed = await awaitTurnEnd(session, prompt.request.seq);
process.stdout.write(`awaitTurnEnd resolved: ${JSON.stringify(observed)}\n`);
const rootWait = Promise.withResolvers<TurnOutcome>();
session.subscribe((record) => {
  if (record.kind !== "event" || record.sessionId !== session.id) {
    return;
  }
  for (const view of record.body.views) {
    if (view.kind === "turn_ended") {
      rootWait.resolve(view.outcome);
    }
  }
}, { sessionId: session.id, afterSeq: prompt.request.seq });
const rootOutcome = await rootWait.promise;
process.stdout.write(`root turn/completed outcome: ${JSON.stringify(rootOutcome)}\n`);

const textOf = (own: boolean): string => session.records()
  .filter((r) => r.kind === "event" && r.seq > prompt.request.seq && (r.sessionId === session.id) === own)
  .flatMap((r) => (r.kind === "event" ? r.body.views : []))
  .map((v) => (v.kind === "text_delta" ? v.text : ""))
  .join("");
process.stdout.write(`root final text: ${JSON.stringify(textOf(true).slice(0, 300))}\n`);
process.stdout.write(`child text: ${JSON.stringify(textOf(false).slice(0, 300))}\n`);
process.stdout.write(`methods seen: ${JSON.stringify(Object.fromEntries(methods))}\n`);
process.stdout.write(`thread ids in envelopes: ${JSON.stringify([...threadIds])}\n`);
process.stdout.write(`graph: ${JSON.stringify(session.graph())}\n`);
process.stdout.write(`usage: ${JSON.stringify(session.usage().value)}\n`);
await session.dispose();
