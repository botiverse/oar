import { describe, expect, test } from "vitest";
import {
  claudeInstallation,
  claudeSession,
  codexInstallation,
  codexSession,
  defineRuntime,
} from "../../packages/oar/src/index.js";
import { asRecord, asRecordList, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { startClaudeAimock, startCodexAimock, type RawProviderRequest } from "../harness/aimock.js";
import { runtimeUnderTest } from "../harness/subject.js";
import { runTurn } from "./support/asserts.js";
import { lastAgentSystem, systemCapture } from "./support/system-prompt.js";

/**
 * SessionOptions on a resume, seen from the provider's side (oar#22): a model
 * or prompt asked for on a resume either reaches the next turn's request or
 * the resume is refused, naming the option. Never the old setting kept
 * without a word.
 */

const FIRST = "OAR-RESUME-FIRST-PROMPT";
const SECOND = "OAR-RESUME-SECOND-PROMPT";
const APPENDED = "OAR-RESUME-APPENDED-PROMPT";

/** Which prompts a system text carries, so a snapshot shows where each one landed without the vendor's own wording. */
function prompts(system: string): string[] {
  return [FIRST, SECOND, APPENDED].filter((marker) => system.includes(marker));
}

/** The body of every agent turn request: one that carries tools (side calls such as session naming carry none). */
function turnBodies(raw: readonly RawProviderRequest[]): JsonRecord[] {
  return raw
    .map((request) => asRecord(request.body) ?? {})
    .filter((body) => Array.isArray(body.tools) && body.tools.length > 0);
}

describe.skipIf(process.env.OAR_TEST !== "claude-aimock")("claude options on a resume", () => {
  const runtime = defineRuntime({ id: "claude-aimock", session: claudeSession, installation: claudeInstallation });

  test("a resume switches the model and both prompts on the next turn", async () => {
    const capture = systemCapture();
    const env = await startClaudeAimock((mock) => { capture.configure(mock); }, { captureRaw: true });
    try {
      const subject = runtimeUnderTest(runtime, env.env);
      const session = await subject.startSession({ model: "sonnet", systemPrompt: FIRST });
      await runTurn(session, "hello");
      await session.dispose();
      const first = prompts(lastAgentSystem(capture.systems));
      const resumed = await subject.startSession({ resume: session.id, model: "haiku", systemPrompt: SECOND, appendSystemPrompt: APPENDED });
      await runTurn(resumed, "and again");
      await resumed.dispose();
      expect({
        models: turnBodies(env.raw).map((body) => body.model),
        reported: [session.model().value, resumed.model().value],
        prompts: [first, prompts(lastAgentSystem(capture.systems))],
      }).toMatchInlineSnapshot(`
        {
          "models": [
            "claude-sonnet-5-5",
            "claude-haiku-4-5-20251001",
          ],
          "prompts": [
            [
              "OAR-RESUME-FIRST-PROMPT",
            ],
            [
              "OAR-RESUME-SECOND-PROMPT",
              "OAR-RESUME-APPENDED-PROMPT",
            ],
          ],
          "reported": [
            "claude-sonnet-5-5",
            "claude-haiku-4-5-20251001",
          ],
        }
      `);
    } finally {
      await env.stop();
    }
  }, 120_000);
});

describe.skipIf(process.env.OAR_TEST !== "codex-aimock")("codex options on a resume", () => {
  const runtime = defineRuntime({ id: "codex-aimock", session: codexSession, installation: codexInstallation });

  // codex applies baseInstructions on thread/resume to that process only: a
  // later resume asking for no prompt runs the thread's stored one again.
  // The model switch itself leaves a `<model_switch>` developer item in the
  // history quoting the instructions in force then, and later turns resend it.
  test("a resume switches the model and the system prompt; the model persists, the prompt does not", async () => {
    const env = await startCodexAimock(undefined, { captureRaw: true });
    try {
      const subject = runtimeUnderTest(runtime, env.env);
      const session = await subject.startSession({ model: "gpt-5.5", systemPrompt: FIRST });
      await runTurn(session, "one");
      await session.dispose();
      const switched = await subject.startSession({ resume: session.id, model: "gpt-5.1", systemPrompt: SECOND });
      await runTurn(switched, "two");
      await switched.dispose();
      const kept = await subject.startSession({ resume: session.id });
      await runTurn(kept, "three");
      await kept.dispose();
      expect({
        turns: turnBodies(env.raw).map((body) => ({
          model: body.model,
          instructions: prompts(String(body.instructions)),
          history: asRecordList(body.input).filter((item) => item.role === "developer").flatMap((item) => prompts(JSON.stringify(item))),
        })),
        reported: [session.model().value, switched.model().value, kept.model().value],
      }).toMatchInlineSnapshot(`
        {
          "reported": [
            "gpt-5.5",
            "gpt-5.1",
            "gpt-5.1",
          ],
          "turns": [
            {
              "history": [],
              "instructions": [
                "OAR-RESUME-FIRST-PROMPT",
              ],
              "model": "gpt-5.5",
            },
            {
              "history": [
                "OAR-RESUME-SECOND-PROMPT",
              ],
              "instructions": [
                "OAR-RESUME-SECOND-PROMPT",
              ],
              "model": "gpt-5.1",
            },
            {
              "history": [
                "OAR-RESUME-SECOND-PROMPT",
              ],
              "instructions": [
                "OAR-RESUME-FIRST-PROMPT",
              ],
              "model": "gpt-5.1",
            },
          ],
        }
      `);
    } finally {
      await env.stop();
    }
  }, 180_000);

  test("an appended prompt on a resume is refused before codex starts", async () => {
    const env = await startCodexAimock(undefined, { captureRaw: true });
    try {
      const subject = runtimeUnderTest(runtime, env.env);
      const session = await subject.startSession({ appendSystemPrompt: FIRST });
      await runTurn(session, "one");
      await session.dispose();
      const before = env.raw.length;
      await expect(subject.startSession({ resume: session.id, appendSystemPrompt: APPENDED })).rejects.toThrowErrorMatchingInlineSnapshot(`[Error: codex cannot apply appendSystemPrompt to a resumed thread (thread/resume drops developerInstructions); set systemPrompt instead or start a new thread]`);
      expect(env.raw.length).toBe(before);
    } finally {
      await env.stop();
    }
  }, 120_000);
});
