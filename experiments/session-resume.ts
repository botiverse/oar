/**
 * LIVE RESUME — Session.id is the runtime-native identity and
 * SessionOptions.resume reattaches to it with context intact.
 *
 * Method: session A learns a codeword and is disposed; a fresh session resumes
 * A's id and must recall the codeword. Proves both the identity plumbing
 * (claude --session-id/--resume, codex thread/start/resume, pi session file
 * by id) and actual transcript continuity. Where the runtime takes a model,
 * the resume also SWITCHES model and asserts the read-back (Session.model())
 * changed — pi otherwise restores the recorded model on resume.
 *
 * Run: pnpm tsx experiments/session-resume.ts <claude|codex>
 *      unset PI_PACKAGE_DIR && pnpm tsx experiments/session-resume.ts pi [modelA] [modelB]
 *
 * ── OBSERVED 2026-09-05, pi SDK 0.84.2 (pi-mono v0.84.2 914cf1472) ──
 * pi persists <agentDir>/sessions/--<cwd slug>--/<file>.jsonl on the first
 * message; Session.id is the file's header id; SessionManager.list(cwd, dir)
 * + open(path) resumes it with the transcript intact. An explicit model on
 * resume replaces the recorded one (createAgentSession: options.model wins;
 * the recorded model is restored only when none is given).
 */
import { runtimes, type SessionEvent } from "../packages/oar/src/index.js";

const runtime = runtimes.require(process.argv[2] ?? "claude");
if (runtime.id === "pi") {
  delete process.env.PI_PACKAGE_DIR;
}
// First-session model and resume model; the resume switches when both exist.
function modelsFor(id: string): { first?: string; resumed?: string } {
  if (id === "claude") {
    return { first: "haiku", resumed: "haiku" };
  }
  if (id === "pi") {
    return {
      first: process.argv[3] ?? "exe-dev-anthropic/claude-haiku-4-5@llm",
      resumed: process.argv[4] ?? "exe-dev-anthropic/claude-sonnet-4-5@llm",
    };
  }
  return {};
}
const modelPair = modelsFor(runtime.id);
const model = modelPair.first === undefined ? {} : { model: modelPair.first };
const resumedModel = modelPair.resumed === undefined ? {} : { model: modelPair.resumed };
const probedInstallation = await runtime.installation?.();
if (probedInstallation?.kind !== "available") {
  throw new Error(`${runtime.id} is not available`);
}
const installation = probedInstallation;

async function runTurn(
  sessionOptions: { cwd: string; model?: string; resume?: string },
  prompt: string,
): Promise<{ id: string; text: string; model: string | null }> {
  const session = await runtime.session(installation, sessionOptions);
  const texts: string[] = [];
  session.subscribe((event: SessionEvent) => {
    if (event.kind === "text_delta") {
      texts.push(event.text);
    }
  });
  const result = session.prompt(prompt);
  if (result.kind !== "turn") {
    throw new Error("busy");
  }
  const outcome = await result.turn.outcome;
  if (outcome.kind !== "completed") {
    throw new Error(`turn ${outcome.kind}`);
  }
  const reported = session.model?.() ?? null;
  await session.dispose();
  return { id: session.id, text: texts.join(""), model: reported };
}

const first = await runTurn({ cwd: process.cwd(), ...model },
  "Remember this codeword: PLUM-42. Reply with exactly ok.");
process.stdout.write(`session A id=${first.id} model=${first.model} replied=${JSON.stringify(first.text.slice(0, 30))}\n`);

const second = await runTurn({ cwd: process.cwd(), resume: first.id, ...resumedModel },
  "What was the codeword I told you earlier? Reply with exactly it.");
process.stdout.write(`resumed id=${second.id} model=${second.model} replied=${JSON.stringify(second.text.slice(0, 40))}\n`);

if (second.id !== first.id) {
  throw new Error("resumed session id mismatch");
}
if (!second.text.includes("PLUM-42")) {
  throw new Error("resumed session lost the transcript");
}
if (modelPair.resumed !== undefined && modelPair.resumed !== modelPair.first) {
  if (second.model !== modelPair.resumed) {
    throw new Error(`resume did not switch the model: reports ${second.model}, wanted ${modelPair.resumed}`);
  }
  if (second.model === first.model) {
    throw new Error("resume + model left the model unchanged");
  }
}
process.stdout.write(`${runtime.id} resume probe PASSED\n`);
