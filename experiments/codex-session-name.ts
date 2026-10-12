/**
 * CODEX SESSION NAME, ARCHIVE AND ACTIVE WRITER (#368): what codex says when
 * a host names a thread, and when it resumes a thread the user archived or
 * another app-server holds. Scripted provider (codex-aimock): no login, no
 * tokens.
 *
 * Method: an OAR session runs one turn and is disposed. A second app-server
 * (standing in for the user's Codex app) reads the thread's name, sets one,
 * reads it back and resumes the thread, so it holds it; OAR then resumes the
 * same thread. That app-server exits, a third archives the thread, and OAR
 * resumes again; then it unarchives, and OAR resumes and runs a turn.
 *
 * Run: pnpm tsx experiments/codex-session-name.ts
 *
 * ── OBSERVED 2026-10-12, Linux x64, codex 0.162.0 ──
 * - A new thread's name is null; after `thread/name/set` it reads back on
 *   `thread/read` and on the `thread/resume` reply, and survives archive and
 *   unarchive.
 * - Resume while another app-server holds the thread: -32600
 *   "thread <id> already has an active writer".
 * - Resume of an archived thread: -32600 "session <id> is archived. Run
 *   `codex unarchive <id>` to unarchive it first."
 * - After `thread/unarchive`, the resume opens and a turn completes.
 */
import { codexInstallation, codexSession, promptAndWait } from "../packages/oar/src/index.js";
import { startAppServerClient, type AppServerClient } from "../packages/oar/src/runtimes/codex/app-server-client.js";
import { asRecord } from "../packages/oar/src/shared/json.js";
import { startCodexAimock } from "../sea-trial/harness/aimock.js";

const env = await startCodexAimock((mock) => {
  mock.onMessage(/[\s\S]*/u, { content: "pong" });
});
const probed = await codexInstallation();
if (probed.kind !== "available" || probed.via !== "executable") { throw new Error(`codex unavailable: ${probed.kind}`); }
const installation = probed;
const { command } = probed;
const sessionEnv = env.env ?? {};
const cwd = process.cwd();

async function app(): Promise<AppServerClient> {
  const client = startAppServerClient(command, sessionEnv);
  await client.spawned;
  client.handle({ onNotification: () => {}, onServerRequest: () => {} });
  await client.request("initialize", { clientInfo: { name: "oar-probe", version: "0" }, capabilities: { experimentalApi: true } });
  client.notify("initialized", {});
  return client;
}

function nameOf(result: unknown): string {
  return JSON.stringify(asRecord(asRecord(result)?.thread)?.name);
}

async function resumeOutcome(what: string, id: string): Promise<void> {
  try {
    const session = await codexSession(installation, { cwd, env: sessionEnv, resume: id });
    const turn = await promptAndWait(session, "again");
    console.log(what, "resumed;", JSON.stringify(turn.kind === "ended" ? turn.outcome : turn));
    await session.dispose();
  } catch (error) {
    const native = asRecord(asRecord(error instanceof Error ? error.cause : undefined)?.native);
    console.log(what, "rejected:", error instanceof Error ? `${error.name}: ${error.message}` : String(error), "native:", JSON.stringify(native));
  }
}

try {
  console.log("codex", installation.version);
  const first = await codexSession(installation, { cwd, env: sessionEnv });
  await promptAndWait(first, "first");
  const { id } = first;
  await first.dispose();

  const holder = await app();
  console.log("name before:", nameOf(await holder.request("thread/read", { threadId: id })));
  await holder.request("thread/name/set", { threadId: id, name: "OAR probe" });
  console.log("name after set:", nameOf(await holder.request("thread/read", { threadId: id })));
  console.log("name on resume reply:", nameOf(await holder.request("thread/resume", { threadId: id })));
  await resumeOutcome("while another app-server holds it:", id);
  holder.kill();
  await holder.exited;

  const archiver = await app();
  await archiver.request("thread/archive", { threadId: id });
  archiver.kill();
  await archiver.exited;
  await resumeOutcome("archived:", id);

  const unarchiver = await app();
  await unarchiver.request("thread/unarchive", { threadId: id });
  console.log("name after unarchive:", nameOf(await unarchiver.request("thread/read", { threadId: id })));
  unarchiver.kill();
  await unarchiver.exited;
  await resumeOutcome("unarchived:", id);
} finally {
  await env.stop();
}
