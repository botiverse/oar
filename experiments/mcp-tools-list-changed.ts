/* oxlint-disable typescript/promise-function-async -- The harness starters pass their promises through. */
/**
 * TOOLS LIST CHANGED (#399): does a running session's model see a change to
 * the tools an MCP server serves? The two turns around a `setTools` are
 * sea-trial/vendor/support/tools-list-changed.ts; this prints, per runtime,
 * the client's MCP traffic, the tools each turn's last request defines, and
 * which probe tools it mentions anywhere else (antigravity and opencode v2
 * list MCP tools in their system instruction or a system update, not in
 * `tools`). The vendor test mcp-tools-list-changed.vendor.test.ts pins the
 * resulting `Runtime.mcpToolsListChanged` declarations.
 *
 * Run: pnpm tsx experiments/mcp-tools-list-changed.ts [claude|codex|pi|opencode|kimi|grok|antigravity ...]
 * Token-free: every runtime talks to a local scripted provider (aimock).
 *
 * ── OBSERVED 2026-10-14, linux x64 (antigravity 1.4.0, codex 0.162.1,
 *    opencode 1.19.0 and 2.0.29 by Otter on isolated installs) ──
 * Every client opened the GET stream and heard the notification.
 * full: pi ^1.2.0, opencode 1.18.30 / 1.19.0 (`tools`), opencode 2.0.29 (a
 * system update announces beta and withdraws alpha; a forced alpha call
 * never reaches the server), antigravity 1.4.0 (the `<mcp_servers>` catalog
 * in the system instruction goes from alpha to beta; alpha is an unknown
 * tool). All list again on the notification.
 * additions: claude 2.1.299 lists again; the second turn defines alpha and
 * beta.
 * none: codex 0.162.0 / 0.162.1, kimi 2.1.1 and grok 1.0.52 never list again;
 * the second turn defines alpha only (grok defines no MCP tools and its
 * `use_tool` answers "Tool not found" for beta).
 */
import type { LLMock } from "@copilotkit/aimock";
import { startClaudeAimock, startCodexAimock, startPiAimock, type AimockEnv } from "../sea-trial/harness/aimock.js";
import { startAntigravityAimock, startGrokAimock, startKimiAimock, startOpencodeAimock } from "../sea-trial/harness/aimock-acp.js";
import { allRuntimes } from "../sea-trial/harness/runtimes.js";
import { runtimeUnderTest } from "../sea-trial/harness/subject.js";
import { asRecord } from "../packages/oar/src/shared/json.js";
import { ALPHA, BETA, defined, lastWithTools, runToolsListChanged } from "../sea-trial/vendor/support/tools-list-changed.js";

const replyOk = (mock: LLMock): void => { mock.onMessage(/[\s\S]*/u, { content: "ok" }); };
const starts: Readonly<Record<string, () => Promise<AimockEnv>>> = {
  claude: () => startClaudeAimock(replyOk, { captureRaw: true }),
  codex: () => startCodexAimock(replyOk, { captureRaw: true }),
  pi: () => startPiAimock(replyOk, { captureRaw: true }),
  opencode: () => startOpencodeAimock(replyOk),
  kimi: () => startKimiAimock(replyOk),
  grok: () => startGrokAimock(replyOk),
  antigravity: () => startAntigravityAimock(replyOk),
};

/** Probe tools a request mentions outside its `tools` array (system instruction, system updates, history). */
function mentioned(body: unknown): readonly string[] {
  const text = JSON.stringify({ ...asRecord(body), tools: undefined });
  return [ALPHA, BETA].filter((name) => text.includes(name));
}

async function probe(id: string): Promise<Record<string, unknown>> {
  const start = starts[id];
  if (start === undefined) {
    return { runtime: id, error: "no aimock backend" };
  }
  const env = await start();
  try {
    const runtime = allRuntimes.require(id);
    const run = await runToolsListChanged(env, (server) => runtimeUnderTest(runtime, env.env).startSession({ mcpServers: [server] }));
    const last = run.turns.map((requests) => lastWithTools(requests) ?? requests.at(-1)?.body);
    return {
      runtime: id,
      declared: runtime.mcpToolsListChanged ?? null,
      relisted: run.relisted,
      defined: last.map((body) => defined(body)),
      mentioned: last.map((body) => mentioned(body)),
      log: run.log,
    };
  } catch (error) {
    return { runtime: id, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await env.stop();
  }
}

const ids = process.argv.slice(2);
for (const id of ids.length > 0 ? ids : ["claude", "codex", "pi", "opencode", "kimi", "grok"]) {
  // oxlint-disable-next-line no-await-in-loop -- one runtime at a time keeps the provider log attributable.
  console.log(JSON.stringify(await probe(id)));
}
