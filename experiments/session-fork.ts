/**
 * SESSION FORK (SessionOptions.fork) on a real claude login: does a fork
 * through the first turn hold only that turn, under a new id, while the
 * source keeps everything and its transcript stays byte-for-byte the same?
 * Costs a few haiku turns.
 *
 * Method: a session is told "remember APPLE", then "remember BANANA", and
 * disposed. The first turn's anchor is read from the session view
 * (`ViewTurn.forkAnchor`), never from native frames. A fork through it is
 * asked which words it remembers; then the source is resumed and asked the
 * same. The source transcript's line count and mtime are compared around the
 * fork.
 *
 * Run: pnpm tsx experiments/session-fork.ts [cwd]
 *
 * ── OBSERVED 2026-11-17, Linux x64, claude 2.1.323, model haiku ──
 * - Both turns' anchors were the uuids of their assistant messages.
 * - The fork opened under a new id and answered "APPLE".
 * - The source transcript was unchanged (same line count and mtime); the
 *   fork's transcript is a separate file under the fork's id.
 * - The resumed source kept its id and answered "APPLE\nBANANA".
 *
 * Codex's `thread/fork { lastTurnId }` floor was found without a login:
 * `codex app-server generate-json-schema --experimental` from each npm
 * release's linux-x64 binary, bisected between 0.118.0 and 0.150.0: 0.142.5's
 * `ThreadForkParams` has no `lastTurnId`, 0.143.0's has; 0.118.0 already has
 * `thread/fork`. The fork flow itself runs against a scripted provider in
 * sea-trial/vendor/session-fork.vendor.test.ts (codex 0.169.0).
 */
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { claudeRuntime, promptAndWait, type Session } from "../packages/oar/src/index.js";
import { initialSessionView, reduceSessionView, type ViewTurn } from "../packages/oar/src/observe/index.js";

const cwd = process.argv[2] ?? await mkdtemp(path.join(tmpdir(), "oar-fork-experiment-"));
const installation = await claudeRuntime.installation();
if (installation.kind !== "available") { throw new Error("claude is not available"); }
const base = { cwd, model: "haiku" };

async function ask(session: Session, prompt: string): Promise<string> {
  const after = session.records().at(-1)?.seq ?? -1;
  await promptAndWait(session, prompt);
  return session.records().filter((record) => record.seq > after && record.kind === "frame")
    .flatMap((record) => record.kind === "frame" ? record.body.events : [])
    .flatMap((event) => event.kind === "text_delta" ? [event.text] : []).join("").trim();
}

/** The transcript claude keeps for `id` under the default configuration home. */
async function transcript(id: string): Promise<{ readonly lines: number; readonly mtimeMs: number }> {
  const file = path.join(homedir(), ".claude", "projects", cwd.replaceAll(/[^a-zA-Z0-9]/gu, "-"), `${id}.jsonl`);
  const [text, info] = await Promise.all([readFile(file, "utf8"), stat(file)]);
  return { lines: text.trim().split("\n").length, mtimeMs: info.mtimeMs };
}

const source = await claudeRuntime.session(installation, base);
console.log("turn 1:", await ask(source, "Remember the word APPLE. Reply with just: ok"));
console.log("turn 2:", await ask(source, "Also remember the word BANANA. Reply with just: ok"));
const view = source.records().reduce((state, record) => reduceSessionView(state, record, source.id), initialSessionView());
const anchors = view.messages.filter((message): message is ViewTurn => message.kind === "turn" && message.outcome !== undefined).map((turn) => turn.forkAnchor);
console.log("anchors:", anchors);
const sourceId = source.id;
await source.dispose();
const before = await transcript(sourceId);

const fork = await claudeRuntime.session(installation, { ...base, resume: sourceId, fork: { through: anchors[0] ?? "" } });
console.log("fork id differs:", fork.id !== sourceId);
console.log("fork:", await ask(fork, "Which words did I ask you to remember? List them, nothing else."));
await fork.dispose();
console.log("source transcript unchanged:", JSON.stringify(await transcript(sourceId)) === JSON.stringify(before));

const again = await claudeRuntime.session(installation, { ...base, resume: sourceId });
console.log("source:", await ask(again, "Which words did I ask you to remember? List them, nothing else."));
await again.dispose();
