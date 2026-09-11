import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import { awaitTurnEnd, piInstallation, piSession, defineRuntime, type Session } from "../../packages/oar/src/index.js";
import { startPiAimock } from "../harness/aimock.js";
import { runtimeUnderTest } from "../harness/subject.js";
import { assertContextUsage, promptTurn, runTurn } from "./support/asserts.js";
import { structuralToolRound, toolRoundFixtures, turnSkeleton } from "./support/tool-round.js";
import { APPEND_MARKER, REPLACE_MARKER, lastAgentSystem, scrubSystem, systemCapture } from "./support/system-prompt.js";

/**
 * SessionOptions.systemPrompt replaces pi's base prompt TEXT, not the whole
 * system prompt: pi 0.84.2 (core/system-prompt.js) keeps its runtime-native
 * additions around the replaced prompt: the append seam, project context
 * files, the skills catalog, the cwd line. The skills catalog lists the
 * HOST's ~/.agents/skills (package-manager.js loadSkills), present or absent
 * per machine, so that block is cut before the snapshot; the cwd line stays
 * (masked by scrubSystem). The seam is documented in docs/runtimes/pi.md;
 * `noSkills` was not taken, since it drops every skill (project ones too).
 */
function withoutHostSkills(system: string): string {
  return system.replace(/\n+The following skills provide specialized instructions[\s\S]*?<\/available_skills>\n/u, "\n");
}

function toolStartedAfter(session: Session, seq: number): boolean {
  for (const record of session.records()) {
    if (record.seq > seq && record.kind === "event" && record.body.views.some((view) => view.kind === "tool_call_started")) {
      return true;
    }
  }
  return false;
}

async function waitFor(predicate: () => boolean, what: string, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for ${what}`);
    }
    // eslint-disable-next-line no-await-in-loop
    await delay(50);
  }
}

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
      // compaction probes); the latest provider request (the compaction
      // summarization or the post-compaction turn) must still carry both
      // markers and none of pi's own base prompt.
      const system = withoutHostSkills(scrubSystem(lastAgentSystem(capture.systems)));
      expect(system).toMatchInlineSnapshot(`
        "OAR-SYSTEM-REPLACE-MARKER you are the oar probe agent

        OAR-SYSTEM-APPEND-MARKER always be brief
        Current working directory: <CWD>
        "
      `);
      // pi's session-scoped compaction events are not dropped: they enter the
      // stream verbatim, with no view.
      const compactionTypes = session.records()
        .flatMap((record) => (record.kind === "event" && record.body.type.startsWith("compaction_") ? [record.body.type] : []));
      expect(compactionTypes).toContain("compaction_start");
      expect(compactionTypes).toContain("compaction_end");
      await session.dispose();
    } finally {
      await env.stop();
    }
  }, 120_000);

  // pi's abort() delivers synchronously and then awaits idle: the accepted
  // answer must be recorded at delivery, ahead of the aborted run's own
  // agent_settled. The live battery (2026-09-11) had it behind the turn end.
  test("abort is answered accepted before pi's own aborted turn end", async () => {
    const env = await startPiAimock((mock) => {
      mock.on({ userMessage: /run the slow tool/u, hasToolResult: false }, {
        toolCalls: [{ name: "bash", arguments: JSON.stringify({ command: "sleep 30; echo never" }) }],
      });
      mock.on({ hasToolResult: true }, { content: "done" });
    });
    try {
      const runtime = defineRuntime({ id: "pi-aimock", session: piSession, installation: piInstallation });
      const session = await runtimeUnderTest(runtime).startSession();
      const started = await promptTurn(session, "run the slow tool");
      await waitFor(() => toolStartedAfter(session, started.request.seq), "the tool call");
      const abort = await session.abort();
      expect(abort.response.body).toEqual({ kind: "accepted" });
      await expect(awaitTurnEnd(session, started.request.seq)).resolves.toEqual({ kind: "aborted" });
      expect(turnSkeleton(session.records(), started.request.seq)).toEqual([
        "request:prompt",
        "response:accepted",
        "tool_call_started:bash",
        "request:abort",
        "response:accepted",
        "tool_call_ended",
        "turn_ended:aborted",
      ]);
      await session.dispose();
    } finally {
      await env.stop();
    }
  }, 60_000);

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
