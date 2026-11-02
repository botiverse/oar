/**
 * Grok append-only resume across native compaction, local provider only.
 * pnpm tsx experiments/grok-resume-compaction.ts [output-directory]
 * Bypasses only the adapter refusal to observe native behavior; no product
 * API or shared placement is enabled. Findings: resume-prompts-2026-11-02.md.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { grokInstallation, promptAndWait, type Session } from "../packages/oar/src/index.js";
import { grokAcpProfile } from "../packages/oar/src/runtimes/grok/session.js";
import { acpSession, type AcpSessionProfile } from "../packages/oar/src/shared/acp/session.js";
import { startGrokAimock } from "../sea-trial/harness/aimock-acp.js";
import { requestsForTurn } from "../sea-trial/vendor/support/resumed-prompts.js";

const old = "GROK_OLD_APPEND_7319";
const next = "GROK_NEW_APPEND_8420";
const summaryMarker = "GROK_COMPACT_SUMMARY_9064";
const out = path.resolve(process.argv[2] ?? "oar-trial-run/grok-resume-compaction");
await mkdir(out, { recursive: true });
let root: string | null = null;
let compacting = false;
const provider = await startGrokAimock((mock) => {
  mock.onMessage(/[\s\S]*/u, () => ({ content: compacting
    ? `${summaryMarker}\n${Array.from({ length: 30 }, (_, i) => `Observation ${String(i)}: The user requested a bounded local prompt configuration experiment. The assistant completed the scripted provider exchange without running tools. The next action is to inspect a request after native compaction.`).join("\n")}`
    : "An ordinary completed response." }));
});
type Configure = Parameters<NonNullable<AcpSessionProfile["configureSession"]>>[0];
const requests = new Map<string, Configure["request"]>();
const start = acpSession({
  ...grokAcpProfile, validateOptions: () => {},
  configureSession: async (context) => { requests.set(context.sessionId, context.request); await grokAcpProfile.configureSession?.(context); },
});
const sessions: Session[] = [];
const observations: { input: string; old: boolean; next: boolean; summaryInHistory: boolean }[] = [];
async function turn(session: Session, input: string): Promise<void> {
  const begin = provider.raw.length;
  const result = await promptAndWait(session, input, { timeoutMs: 30_000 });
  assert.ok(result.kind === "ended" && result.outcome.kind === "completed");
  const main = requestsForTurn(provider.raw.slice(begin), `<user_query>\n${input}\n</user_query>`);
  assert.ok(main.length > 0, "missing main provider request");
  for (const row of main) {
    observations.push({ input, old: row.system.includes(old), next: row.system.includes(next), summaryInHistory: row.history.includes(summaryMarker) });
  }
}
try {
  root = await mkdtemp(path.join(tmpdir(), "oar-grok-resume-compact-"));
  const installation = await grokInstallation();
  assert.ok(installation.kind === "available" && installation.via === "executable");
  const first = await start(installation, { cwd: root, env: provider.env, appendSystemPrompt: old });
  sessions.push(first);
  await turn(first, "GROK_SEED");
  await first.dispose();
  const resumed = await start(installation, { cwd: root, env: provider.env, resume: first.id, appendSystemPrompt: next });
  sessions.push(resumed);
  assert.equal(resumed.id, first.id);
  await turn(resumed, "GROK_BEFORE");
  const request = requests.get(resumed.id);
  assert.ok(request !== undefined);
  compacting = true;
  const begin = provider.raw.length;
  // ACP extension dispatch adds the underscore on the JSON-RPC wire.
  const compact = await request("_x.ai/compact_conversation", { sessionId: resumed.id });
  compacting = false;
  const compactRequests = provider.raw.length - begin;
  assert.ok(compactRequests > 0, "native compact must reach the provider");
  await turn(resumed, "GROK_AFTER");
  assert.ok(observations.every((row) => row.old && !row.next), "append-only native resume behavior changed");
  assert.ok(observations.some((row) => row.input === "GROK_AFTER" && row.summaryInHistory), "must observe the new native summary in subsequent history");
  const selected = { version: installation.version, platform: process.platform, arch: process.arch, compact, compactRequests, observations };
  await writeFile(path.join(out, "selected.json"), `${JSON.stringify(selected, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(selected)}\n`);
} finally {
  try {
    for (const session of sessions) {
      // oxlint-disable-next-line no-await-in-loop -- These sessions share a saved native ID and configuration directory.
      await session.dispose();
    }
    await writeFile(path.join(out, "raw.json"), JSON.stringify({ provider: provider.raw, records: sessions.map((session) => session.records()) }, null, 2));
  } finally {
    try { await provider.stop(); } finally { if (root !== null) { await rm(root, { recursive: true, force: true }); } }
  }
}
