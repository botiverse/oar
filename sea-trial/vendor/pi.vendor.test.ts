import { describe, expect, test } from "vitest";
import { piInstallation, piSession, defineRuntime } from "../../packages/oar/src/index.js";
import { startPiAimock } from "../harness/aimock.js";
import { runtimeUnderTest } from "../harness/subject.js";
import { assertContextUsage, runTurn } from "./support/asserts.js";
import { structuralToolRound, toolRoundFixtures } from "./support/tool-round.js";
import { APPEND_MARKER, REPLACE_MARKER, lastAgentSystem, scrubSystem, systemCapture } from "./support/system-prompt.js";

/** Vendor-specific error edges for the in-process pi SDK (scripted provider). */
describe.skipIf(process.env.OAR_TEST !== "pi-aimock")("pi vendor error edges", () => {
  test("an invalid request ends the turn with the provider error in pi's own agent_end", async () => {
    const env = await startPiAimock((mock) => {
      mock.onMessage(/[\s\S]*/u, {
        error: { message: "max_tokens exceeds model limit", type: "invalid_request_error" },
        status: 400,
      });
    });
    try {
      const runtime = defineRuntime({ id: "pi-aimock", session: piSession, installation: piInstallation });
      const session = await runtimeUnderTest(runtime).startSession();
      await expect(runTurn(session, "hello")).resolves.toMatchInlineSnapshot(`
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
          "request:prompt",
          "response:accepted",
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

  test("system prompt replace+append land and SURVIVE threshold auto-compaction, and compaction is in the stream", async () => {
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
      for (const input of ["topic one", "topic two", "topic three"]) {
        await runTurn(session, input);
      }
      // Threshold compaction fired during those turns (recipe pinned in the
      // compaction probes); the latest provider request — the compaction
      // summarization or the post-compaction turn — must still carry both
      // markers and none of pi's own base prompt.
      expect(scrubSystem(lastAgentSystem(capture.systems))).toMatchInlineSnapshot(`
        "OAR-SYSTEM-REPLACE-MARKER you are the oar probe agent

        OAR-SYSTEM-APPEND-MARKER always be brief
        Current working directory: <CWD>
        "
      `);
      // v2: pi's session-scoped compaction events are no longer dropped —
      // they enter the stream verbatim, with no view.
      const compactionTypes = session.records()
        .flatMap((record) => (record.kind === "event" && record.body.type.startsWith("compaction_") ? [record.body.type] : []));
      expect(compactionTypes).toContain("compaction_start");
      expect(compactionTypes).toContain("compaction_end");
      await session.dispose();
    } finally {
      await env.stop();
    }
  }, 120_000);

  test("contextUsage() is current at turn end and every SDK event is one record", async () => {
    const env = await startPiAimock();
    try {
      const runtime = defineRuntime({ id: "pi-aimock", session: piSession, installation: piInstallation });
      const session = await runtimeUnderTest(runtime, undefined).startSession();
      await runTurn(session, "say hi");
      assertContextUsage(session.contextUsage());
      const types = session.records().flatMap((record) => (record.kind === "event" ? [record.body.type] : []));
      expect(types).toContain("agent_start");
      expect(types).toContain("agent_end");
      expect(types.at(-1)).toBe("agent_settled");
      expect(session.model()).toMatch(/\//u);
      await session.dispose();
    } finally {
      await env.stop();
    }
  }, 60_000);
});
