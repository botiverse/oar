/**
 * RESUME IN ANOTHER WORKING DIRECTORY: can a conversation opened in one
 * directory be resumed by its native id in another, keeping its context and
 * working in the new directory?
 *
 * Why: a host that moves a session to another directory (Ferry's "change the
 * working directory") either resumes the same native conversation there, when
 * the runtime can, or starts a new one with a handoff. Which runtime can is a
 * fact to measure, not to guess from a resume method that takes a `cwd`.
 *
 * Shape, per runtime: open in directory A, teach a codeword, dispose. Resume
 * the same id with `cwd` B. Ask the model to run `pwd` and to say the
 * codeword. Supported means: the resume opens, the codeword comes back, and
 * the shell call runs in B.
 *
 * Run: pnpm tsx experiments/resume-other-cwd.ts <runtime...> [--model <id>] [--out <dir>]
 * Burns two short turns per runtime; writes an oar-voyage/3 log per phase and
 * a facts.json.
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openVoyage, promptAndWait, toolResultText, type Session } from "../packages/oar/src/index.js";
import { allRuntimes } from "../sea-trial/harness/runtimes.js";

// Defaults reflect the live test account; --model overrides a single runtime.
const MODEL: Readonly<Record<string, string>> = {
  claude: "haiku",
  codex: "gpt-6-luna",
  cursor: "gpt-5.4-nano",
  pi: "exe-dev-openai/gpt-6-luna@llm",
};
const CODEWORD = "HERON-58";

const args = process.argv.slice(2);
const outFlag = args.indexOf("--out");
const modelFlag = args.indexOf("--model");
const modelOverride = modelFlag === -1 ? undefined : args[modelFlag + 1];
const out = outFlag === -1
  ? path.join(process.cwd(), "oar-trial-run", `resume-other-cwd-${new Date().toISOString().replaceAll(":", "-")}`)
  : args[outFlag + 1] ?? "";
const ids = args.filter((arg, index) => !arg.startsWith("--")
  && (outFlag === -1 || index !== outFlag + 1)
  && (modelFlag === -1 || index !== modelFlag + 1));
if (modelFlag !== -1 && (modelOverride === undefined || modelOverride.startsWith("--") || ids.length !== 1)) {
  throw new Error("--model requires a model id and exactly one runtime");
}
mkdirSync(out, { recursive: true });

function record(session: Session, name: string, header: { readonly runtime: string; readonly cwd: string }): void {
  const log = openVoyage(path.join(out, name), { ...header, sessionId: session.id, startedAt: Date.now(), recorder: "experiments/resume-other-cwd.ts" });
  session.rawEvents((entry) => {
    log.record(entry);
  }, { sessionId: session.id, afterSeq: -1 });
}

function textAfter(session: Session, seq: number): string {
  return session.records()
    .filter((entry) => entry.seq > seq && entry.kind === "frame" && entry.agentPath.length === 0)
    .flatMap((entry) => (entry.kind === "frame" ? entry.body.events : []))
    .flatMap((event) => (event.kind === "text_delta" ? [event.text] : []))
    .join("");
}

function toolOutputs(session: Session, seq: number): string[] {
  return session.records()
    .filter((entry) => entry.seq > seq && entry.kind === "frame")
    .flatMap((entry) => (entry.kind === "frame" ? entry.body.events : []))
    .flatMap((event) => (event.kind === "tool_call_ended" ? [toolResultText(event.content) ?? ""] : []));
}

/** Open in A, teach, dispose; resume in B, ask. Facts go into `result`. */
async function probe(id: string, result: Record<string, unknown>, dirs: { readonly dirA: string; readonly dirB: string }): Promise<void> {
  const runtime = allRuntimes.require(id);
  const model = modelOverride ?? MODEL[id];
  const installation = await runtime.installation?.();
  if (installation?.kind !== "available") {
    result.skipped = installation?.kind ?? "no installation probe";
    return;
  }
  const first = await runtime.session(installation, { cwd: dirs.dirA, ...(model === undefined ? {} : { model }) });
  record(first, `${id}-a.voyage.jsonl`, { runtime: id, cwd: dirs.dirA });
  const taught = await promptAndWait(first, `Remember this codeword: ${CODEWORD}. Reply with exactly ok.`, { timeoutMs: 180_000 });
  result.taught = taught.kind === "ended" ? taught.outcome : taught;
  result.sessionId = first.id;
  await first.dispose();
  const opened = await runtime.session(installation, { cwd: dirs.dirB, resume: first.id, ...(model === undefined ? {} : { model }) })
    .then((session) => ({ session }), (error: unknown) => ({ refused: error instanceof Error ? error.message.slice(0, 400) : String(error) }));
  if ("refused" in opened) {
    result.resumeOpen = opened;
    result.supported = false;
    return;
  }
  const resumed = opened.session;
  record(resumed, `${id}-b.voyage.jsonl`, { runtime: id, cwd: dirs.dirB });
  result.resumedId = resumed.id;
  const asked = await promptAndWait(resumed, "Use your shell tool to run `pwd && ls`. Then reply with the codeword I asked you to remember earlier, followed by the directory pwd printed.", { timeoutMs: 180_000 });
  const seq = asked.kind === "rejected" ? -1 : asked.result.seq;
  result.asked = asked.kind === "ended" ? asked.outcome : asked;
  const text = textAfter(resumed, seq);
  const outputs = toolOutputs(resumed, seq);
  result.text = text.slice(0, 400);
  result.toolOutputs = outputs.map((output) => output.slice(0, 400));
  result.recalled = text.includes(CODEWORD);
  result.ranInB = outputs.some((output) => output.includes(dirs.dirB) || output.includes("marker-b.txt"));
  result.ranInA = outputs.some((output) => output.includes(dirs.dirA));
  result.supported = result.recalled === true && result.ranInB === true;
  await resumed.dispose();
}

const facts: Record<string, unknown> = {};
for (const id of ids) {
  const scratch = mkdtempSync(path.join(tmpdir(), `oar-cwd-${id}-`));
  const root = realpathSync(scratch);
  const dirs = { dirA: path.join(root, "dir-a"), dirB: path.join(root, "dir-b") };
  mkdirSync(dirs.dirA);
  mkdirSync(dirs.dirB);
  writeFileSync(path.join(dirs.dirB, "marker-b.txt"), "B\n");
  const result: Record<string, unknown> = { ...dirs, model: modelOverride ?? MODEL[id] ?? null };
  facts[id] = result;
  try {
    // oxlint-disable-next-line no-await-in-loop -- runtimes run one after another.
    await probe(id, result, dirs);
  } catch (error) {
    result.error = error instanceof Error ? error.message.slice(0, 400) : String(error);
  }
  process.stdout.write(`${id}: ${JSON.stringify({ supported: result.supported, recalled: result.recalled, ranInB: result.ranInB, ranInA: result.ranInA, refused: result.resumeOpen, error: result.error, skipped: result.skipped })}\n`);
}
writeFileSync(path.join(out, "facts.json"), `${JSON.stringify(facts, null, 2)}\n`);
process.stdout.write(`facts: ${path.join(out, "facts.json")}\n`);
