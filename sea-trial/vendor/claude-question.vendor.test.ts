import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import type { Event } from "../../packages/oar/src/contracts/session.js";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { claudeInstallation, claudeRuntime } from "../../packages/oar/src/index.js";
import { startClaudeAimock } from "../harness/aimock.js";

/**
 * The real claude binary, its real question tool, a scripted provider, and a
 * synthetic host answer. This is the end-to-end regression for
 * `SessionOptions.questions: "ask"`: the model's AskUserQuestion reaches the
 * host as a `toApp` request, `answerQuestion` writes claude's native reply,
 * and the SAME turn reads the answer back.
 */
describe.skipIf(process.env.OAR_TEST !== "claude-aimock")("claude host-answered questions", () => {
  test("the answer reaches the model in the same turn, and no approval is granted", async () => {
    const nonce = randomUUID();
    const question = `Which synthetic colour ${nonce}?`;
    let asked = false;
    const env = await startClaudeAimock((mock) => {
      mock.onMessage(/[\s\S]*/u, () => {
        if (asked) {
          return { content: "QUESTION_ANSWERED" };
        }
        asked = true;
        return { toolCalls: [{ name: "AskUserQuestion", arguments: JSON.stringify({ questions: [
          { question, header: "Colour", multiSelect: false, options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }] },
        ] }) }] };
      });
    }, { captureRaw: true });
    const cwd = await mkdtemp(path.join(tmpdir(), "oar-claude-question-"));
    const home = path.join(cwd, "home");
    const installation = await claudeInstallation();
    if (installation.kind !== "available") { throw new Error(`claude is not available: ${installation.kind}`); }
    // Isolated home/config, like the experiment probe: the scripted provider
    // must win over any host settings and no real account is consulted.
    const session = await claudeRuntime.session(installation, { cwd, questions: "ask", env: {
      ...env.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    } });
    const answerQuestion = session.answerQuestion?.bind(session);
    const events: Event[] = [];
    session.events((event) => { events.push(event); });
    try {
      expect("answer" in session).toBe(false);
      if (answerQuestion === undefined) { throw new Error("the session has no answerQuestion"); }
      expect(session.capabilities.appRequests).toMatchObject({ kinds: [], questions: true });
      const prompt = await session.prompt("QUESTION_PROBE");
      expect(prompt.kind).toBe("accepted");
      for (let attempt = 0; attempt < 300 && !events.some((event) => event.kind === "app_request"); attempt += 1) {
        await delay(20);
      }
      const request = events.find((event) => event.kind === "app_request");
      expect(request).toMatchObject({ kind: "app_request", type: "can_use_tool" });
      if (request?.kind !== "app_request") { throw new Error("no app_request event"); }

      const outcome = await answerQuestion(request.requestId, { answers: { [question]: "Blue" } });
      expect(outcome.kind).toBe("unconfirmed"); // claude acknowledges no reply
      const recorded = "response" in outcome ? outcome.response : undefined;
      expect(recorded?.body).toMatchObject({ kind: "answered", by: "host" });

      await expect(awaitTurnEnd(session, prompt.seq)).resolves.toMatchObject({ kind: "completed" });
      const answered = events.find((event) => event.kind === "app_answered");
      expect(answered).toMatchObject({ kind: "app_answered", requestId: request.requestId, by: "host" });
      // The tool result the model read back: claude's own `"question"="answer"` form.
      const answeredText = events
        .flatMap((event) => event.kind === "tool_call_ended" ? event.content ?? [] : [])
        .flatMap((part) => part.type === "text" ? [part.text] : [])
        .join("\n");
      expect(answeredText).toContain(`"${question}"="Blue"`);
      expect(events.some((event) => event.kind === "app_request_cancelled")).toBe(false);
    } finally {
      await session.dispose();
      await env.stop();
      await rm(cwd, { recursive: true, force: true });
    }
  }, 60_000);
});
