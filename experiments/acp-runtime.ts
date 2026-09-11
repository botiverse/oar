/**
 * LIVE RUN OF THE PUBLIC GROK/KIMI RUNTIME ADAPTER.
 *
 * Pins the real executable handshake, one shell-tool turn, the v2 record
 * stream (every frame recorded, views, toApp terminal/permission requests,
 * child-session records and the graph), and the vendor account-usage
 * surface. It prints only a structural summary: no prompt text, tool
 * input/output, paths, or tokens.
 *
 * Observed 2026-08-27: grok 1.0.5, kimi 0.38.0.
 *
 * Run:
 *   OAR_GROK_BIN=/path/to/grok GROK_HOME=/isolated/home pnpm tsx experiments/acp-runtime.ts grok
 *   OAR_KIMI_BIN=/path/to/kimi KIMI_CODE_HOME=/isolated/home pnpm tsx experiments/acp-runtime.ts kimi
 */
import assert from "node:assert/strict";
import {
  grokRuntime,
  kimiRuntime,
  promptAndWait,
  type Runtime,
  type SessionRecord,
} from "../packages/oar/src/index.js";

const [runtimeName] = process.argv.slice(2);
function selectRuntime(name: string | undefined): Runtime {
  if (name === "grok") {
    return grokRuntime;
  }
  if (name === "kimi") {
    return kimiRuntime;
  }
  throw new Error("usage: tsx experiments/acp-runtime.ts <grok|kimi>");
}
const runtime = selectRuntime(runtimeName);

const installationProbe = runtime.installation;
assert.ok(installationProbe !== undefined);
const installation = await installationProbe();
assert.ok(installation.kind === "available", `${runtime.id} is not available`);
const session = await runtime.session(installation, {
  cwd: process.cwd(),
  ...(process.env.OAR_TEST_MODEL === undefined ? {} : { model: process.env.OAR_TEST_MODEL }),
});
const run = await promptAndWait(session, [
  "Use the shell tool to run `printf OAR_ACP_TOOL_OK` and inspect its output.",
  "Then reply with exactly OAR_ACP_DONE.",
].join(" "));
assert.equal(run.kind, "ended", "prompt was not accepted");
assert.deepEqual(run.outcome, { kind: "completed" });

const records: readonly SessionRecord[] = session.records();
const views = records.flatMap((record) => (record.kind === "event" ? record.body.views : []));
const text = views
  .flatMap((view) => (view.kind === "text_delta" ? [view.text] : []))
  .join("");
const tools = views.flatMap((view) => (view.kind === "tool_call_started" ? [view.tool] : []));
assert.ok(text.includes("OAR_ACP_DONE"), "runtime did not return the completion marker");
assert.ok(tools.length > 0, "runtime did not expose a shell tool call");

const usage = runtime.accountUsage === undefined
  ? undefined
  : await runtime.accountUsage(installation);
const contextUsage = session.contextUsage();
const skeleton = records.map((record) => {
  if (record.kind === "event") {
    const kinds = record.body.views.map((view) => view.kind).join("+");
    return `event ${record.body.type}${kinds === "" ? "" : ` → ${kinds}`}${record.sessionId === session.id ? "" : " (child session)"}`;
  }
  return record.kind === "request"
    ? `${record.direction} ${record.body.kind === "native" ? record.body.type : record.body.kind}`
    : `response ${record.body.kind}`;
});
process.stdout.write(`${JSON.stringify({
  runtime: runtime.id,
  version: installation.via === "executable" ? (installation.version ?? null) : null,
  capabilities: session.capabilities,
  outcome: run.outcome,
  skeleton,
  toolNames: tools,
  graph: session.graph(),
  contextUsageReported: contextUsage !== null,
  accountUsageKind: usage?.kind ?? "absent",
}, null, 2)}\n`);
await session.dispose();
