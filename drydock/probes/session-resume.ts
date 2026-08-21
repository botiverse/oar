/**
 * LIVE RESUME — Session.id is the runtime-native identity and
 * SessionOptions.resume reattaches to it with context intact.
 *
 * Method: session A learns a codeword and is disposed; a fresh session resumes
 * A's id and must recall the codeword. Proves both the identity plumbing
 * (claude --session-id/--resume, codex thread/start/resume) and actual
 * transcript continuity.
 *
 * Run: pnpm tsx drydock/probes/session-resume.ts <claude|codex>
 */
import { runtimes, type SessionEvent } from "../../packages/oar/src/index.js";

const runtime = runtimes.require(process.argv[2] ?? "claude");
const model = runtime.id === "claude" ? { model: "haiku" } : {};
const probedInstallation = await runtime.installation?.();
if (probedInstallation?.kind !== "available") {
  throw new Error(`${runtime.id} is not available`);
}
const installation = probedInstallation;

async function runTurn(sessionOptions: { cwd: string; model?: string; resume?: string }, prompt: string): Promise<{ id: string; text: string }> {
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
  await session.dispose();
  return { id: session.id, text: texts.join("") };
}

const first = await runTurn({ cwd: process.cwd(), ...model },
  "Remember this codeword: PLUM-42. Reply with exactly ok.");
process.stdout.write(`session A id=${first.id} replied=${JSON.stringify(first.text.slice(0, 30))}\n`);

const second = await runTurn({ cwd: process.cwd(), resume: first.id, ...model },
  "What was the codeword I told you earlier? Reply with exactly it.");
process.stdout.write(`resumed id=${second.id} replied=${JSON.stringify(second.text.slice(0, 40))}\n`);

if (second.id !== first.id) {
  throw new Error("resumed session id mismatch");
}
if (!second.text.includes("PLUM-42")) {
  throw new Error("resumed session lost the transcript");
}
process.stdout.write(`${runtime.id} resume probe PASSED\n`);
