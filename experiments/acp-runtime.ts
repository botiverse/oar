/**
 * LIVE RUN OF THE PUBLIC GROK/KIMI RUNTIME ADAPTER.
 *
 * Pins the real executable handshake, one shell-tool turn, OAR event framing,
 * and the vendor account-usage surface. It prints only a
 * structural summary: no prompt text, tool input/output, paths, or tokens.
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
  type Runtime,
  type SessionEvent,
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
const events: SessionEvent[] = [];
session.subscribe((event) => {
  events.push(event);
});
const result = session.prompt([
  "Use the shell tool to run `printf OAR_ACP_TOOL_OK` and inspect its output.",
  "Then reply with exactly OAR_ACP_DONE.",
].join(" "));
assert.equal(result.kind, "turn");
const outcome = await result.turn.outcome;
assert.deepEqual(outcome, { kind: "completed" });

const text = events
  .filter((event) => event.kind === "text_delta")
  .map((event) => event.text)
  .join("");
const tools = events
  .filter((event) => event.kind === "tool_call_started")
  .map((event) => event.tool);
assert.ok(text.includes("OAR_ACP_DONE"), "runtime did not return the completion marker");
assert.ok(tools.length > 0, "runtime did not expose a shell tool call");

const usage = runtime.accountUsage === undefined
  ? undefined
  : await runtime.accountUsage(installation);
const contextUsage = session.contextUsage?.() ?? null;
process.stdout.write(`${JSON.stringify({
  runtime: runtime.id,
  version: installation.via === "executable" ? (installation.version ?? null) : null,
  outcome,
  eventKinds: events.map((event) => event.kind),
  toolNames: tools,
  contextUsageReported: contextUsage !== null,
  accountUsageKind: usage?.kind ?? "absent",
}, null, 2)}\n`);
await session.dispose();
