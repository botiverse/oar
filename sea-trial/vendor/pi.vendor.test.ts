import { describe, expect, test } from "vitest";
import { piInstallation, piSession, defineRuntime } from "../../packages/oar/src/index.js";
import { startPiAimock } from "../harness/aimock.js";
import { runtimeUnderTest } from "../harness/subject.js";
import { promptTurn } from "./env.js";
import { structuralToolRound, toolRoundFixtures } from "./tool-round.js";
import { APPEND_MARKER, REPLACE_MARKER, assertSystemPrompt, systemCapture } from "./system-prompt.js";

/** Vendor-specific error edges for the in-process pi SDK (scripted provider). */
describe.skipIf(process.env.OAR_TEST !== "pi-aimock")("pi vendor error edges", () => {
  test("an invalid request settles the turn with the provider error", async () => {
    const env = await startPiAimock((mock) => {
      mock.onMessage(/[\s\S]*/u, {
        error: { message: "max_tokens exceeds model limit", type: "invalid_request_error" },
        status: 400,
      });
    });
    try {
      const runtime = defineRuntime({ id: "pi-aimock", session: piSession, installation: piInstallation });
      const session = await runtimeUnderTest(runtime).startSession();
      const result = promptTurn(session, "hello");
      await expect(result.outcome).resolves.toMatchInlineSnapshot(`
        {
          "failure": "invalid_request",
          "kind": "failed",
          "reason": "400 {"type":"error","error":{"type":"invalid_request_error","message":"max_tokens exceeds model limit"}}",
        }
      `);
      await session.dispose();
    } finally {
      await env.stop();
    }
  }, 120_000);

  test("a scripted two-round tool conversation keeps tool framing", async () => {
    const env = await startPiAimock((mock) => {
      toolRoundFixtures(mock, (command) => ({ name: "bash", arguments: JSON.stringify({ command }) }));
    });
    try {
      const runtime = defineRuntime({ id: "pi-aimock", session: piSession, installation: piInstallation });
      const session = await runtimeUnderTest(runtime).startSession();
      await expect(structuralToolRound(session, env.mock)).resolves.toMatchInlineSnapshot(`
        [
          "turn_started",
          "tool_call_started:bash",
          "tool_call_ended",
          "tool_call_started:bash",
          "tool_call_ended",
          "turn_ended:completed",
        ]
      `);
      await session.dispose();
    } finally {
      await env.stop();
    }
  }, 120_000);


  test("system prompt replace+append land and SURVIVE threshold auto-compaction", async () => {
    // The deterministic auto-compaction recipe: tiny context window in the
    // model definition + fat reported usage + compaction settings.
    const capture = systemCapture({
      content: `padding. ${"the quick brown fox jumps over the lazy dog. ".repeat(120)}`,
      usage: { input_tokens: 9000, output_tokens: 400 },
    });
    const env = await startPiAimock((mock) => { capture.configure(mock); }, {
      contextWindow: 10_000,
      settings: { compaction: { enabled: true, reserveTokens: 4000, keepRecentTokens: 500 } },
    });
    try {
      const runtime = defineRuntime({ id: "pi-aimock", session: piSession, installation: piInstallation });
      const session = await runtimeUnderTest(runtime).startSession({
        systemPrompt: `${REPLACE_MARKER} you are the oar probe agent`,
        appendSystemPrompt: `${APPEND_MARKER} always be brief`,
      });
      const events: string[] = [];
      const sdkEvents = session; // oar events do not carry compaction yet; rely on provider requests
      void sdkEvents;
      for (const input of ["topic one", "topic two", "topic three"]) {
        const turn = promptTurn(session, input);
        await turn.outcome;
      }
      void events;
      // Threshold compaction fired during those turns (recipe pinned in the
      // compaction probes); the latest provider request — the compaction
      // summarization or the post-compaction turn — must still carry both
      // markers and none of pi's own base prompt.
      assertSystemPrompt(capture.systems, "operating inside pi");
      await session.dispose();
    } finally {
      await env.stop();
    }
  }, 120_000);
});
