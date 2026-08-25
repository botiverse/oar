import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import type { SessionEvent } from "../../packages/oar/src/contracts/session.js";
import { claudeInstallation, claudeSession, defineRuntime } from "../../packages/oar/src/index.js";
import { claudeAccountUsage } from "../../packages/oar/src/runtimes/claude/index.js";
import { assertContextUsage, expectAvailable, promptTurn, withProcessEnv } from "./support/asserts.js";
import { startClaudeAimock } from "../harness/aimock.js";
import { runtimeUnderTest } from "../harness/subject.js";
import { structuralToolRound, toolRoundFixtures } from "./support/tool-round.js";
import { APPEND_MARKER, REPLACE_MARKER, lastAgentSystem, scrubSystem, systemCapture } from "./support/system-prompt.js";

/**
 * Vendor-specific error edges: what the REAL claude harness does, driven by a
 * scripted provider. Gated on OAR_TEST=claude-aimock (skipped elsewhere) and
 * run by the behavior CI job after the shared suite.
 *
 * Pinned by live observation (2026-08-22, claude 2.1.237):
 * - a non-retryable 4xx fails the turn fast; the result frame carries
 *   is_error=true with subtype "success" (!) and the error text in `result`
 * - a persistent 401 is retried SILENTLY — no stream-json output, no
 *   settlement. Pinned as a bounded-silence test below: our fake timers
 *   cannot reach the CLI child's internal retry clock, but a few seconds of
 *   provable silence is cheap and catches any future fail-fast change.
 *   Applications guard the hang class with observeStalls.
 */
describe.skipIf(process.env.OAR_TEST !== "claude-aimock")("claude vendor error edges", () => {
  test("an invalid request fails the turn fast with the API error", async () => {
    const env = await startClaudeAimock((mock) => {
      mock.onMessage(/[\s\S]*/u, {
        error: { message: "max_tokens exceeds model limit", type: "invalid_request_error" },
        status: 400,
      });
    });
    try {
      const runtime = defineRuntime({ id: "claude-aimock", session: claudeSession, installation: claudeInstallation });
      const session = await runtimeUnderTest(runtime, env.env).startSession();
      const result = promptTurn(session, "hello");
      await expect(result.outcome).resolves.toMatchInlineSnapshot(`
        {
          "failure": "invalid_request",
          "kind": "failed",
          "reason": "API Error: 400 max_tokens exceeds model limit",
        }
      `);
      await session.dispose();
    } finally {
      await env.stop();
    }
  }, 60_000);

  test("account usage under an API key (no subscription login)", async () => {
    const env = await startClaudeAimock();
    try {
      await withProcessEnv(env.env ?? {}, async () => {
        const installation = await claudeInstallation();
        expectAvailable(installation, "claude");
        const outcome = await claudeAccountUsage(installation, { timeoutMs: 30_000 }).then(
          (value) => ({ resolved: value }),
          (error: unknown) => ({ threw: String(error) }),
        );
        expect(outcome).toMatchInlineSnapshot(`
          {
            "resolved": {
              "kind": "unsupported",
            },
          }
        `);
      });
    } finally {
      await env.stop();
    }
  }, 60_000);

  test("an invalid key is retried silently: no events, no settlement", async () => {
    const env = await startClaudeAimock((mock) => {
      mock.onMessage(/[\s\S]*/u, {
        error: { message: "invalid x-api-key", type: "authentication_error" },
        status: 401,
      });
    });
    try {
      const runtime = defineRuntime({ id: "claude-aimock", session: claudeSession, installation: claudeInstallation });
      const session = await runtimeUnderTest(runtime, env.env).startSession();
      const events: SessionEvent[] = [];
      session.subscribe((event) => {
        events.push(event);
      });
      const result = promptTurn(session, "hello");
      const settled = await Promise.race([
        result.outcome.then(() => true),
        sleep(3000).then(() => false),
      ]);
      // turn_started is OUR kernel's framing; everything else would have to
      // come from claude — and nothing does.
      expect({
        settled,
        fromRuntime: events.map((event) => event.kind).filter((kind) => kind !== "turn_started"),
      }).toMatchInlineSnapshot(`
        {
          "fromRuntime": [],
          "settled": false,
        }
      `);
      await session.dispose();
    } finally {
      await env.stop();
    }
  }, 60_000);

  test("a scripted two-round tool conversation keeps tool framing", async () => {
    const env = await startClaudeAimock((mock) => {
      toolRoundFixtures(mock, (command) => ({ name: "Bash", arguments: JSON.stringify({ command }) }));
    });
    try {
      const runtime = defineRuntime({ id: "claude-aimock", session: claudeSession, installation: claudeInstallation });
      const session = await runtimeUnderTest(runtime, env.env).startSession();
      await expect(structuralToolRound(session, env.mock)).resolves.toMatchInlineSnapshot(`
        [
          "turn_started",
          "tool_call_started:Bash",
          "tool_call_ended",
          "tool_call_started:Bash",
          "tool_call_ended",
          "turn_ended:completed",
        ]
      `);
      await session.dispose();
    } finally {
      await env.stop();
    }
  }, 120_000);


  test("YOLO default: claude runs an unknown command without any grant", async () => {
    const env = await startClaudeAimock((mock) => {
      mock.on({ userMessage: /run the say probe/u, hasToolResult: false }, {
        toolCalls: [{ name: "Bash", arguments: JSON.stringify({ command: "oar-say-probe hello" }) }],
      });
      mock.on({ hasToolResult: true }, { content: "probe done" });
    });
    try {
      const runtime = defineRuntime({ id: "claude-aimock", session: claudeSession, installation: claudeInstallation });
      const session = await runtimeUnderTest(runtime, env.env).startSession();
      // The binary does not exist — irrelevant: under the YOLO default claude
      // RUNS it (tool_call framing appears) instead of stopping for approval,
      // which is the coxswain say-bridge scenario in miniature.
      await expect(structuralToolRound(session, env.mock, "please run the say probe")).resolves.toMatchInlineSnapshot(`
        [
          "turn_started",
          "tool_call_started:Bash",
          "tool_call_ended",
          "turn_ended:completed",
        ]
      `);
      await session.dispose();
    } finally {
      await env.stop();
    }
  }, 120_000);

  test("system prompt replace+append land and SURVIVE manual compaction", async () => {
    const capture = systemCapture();
    const env = await startClaudeAimock((mock) => { capture.configure(mock); });
    try {
      const runtime = defineRuntime({ id: "claude-aimock", session: claudeSession, installation: claudeInstallation });
      const session = await runtimeUnderTest(runtime, env.env).startSession({
        systemPrompt: `${REPLACE_MARKER} you are the oar probe agent`,
        appendSystemPrompt: `${APPEND_MARKER} always be brief`,
      });
      const first = promptTurn(session, "hello there");
      await first.outcome;
      const before = scrubSystem(lastAgentSystem(capture.systems));
      expect(before).toMatchInlineSnapshot(`
        "x-anthropic-billing-header: cc_version=<VERSION>; cc_entrypoint=sdk-cli;You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.OAR-SYSTEM-REPLACE-MARKER you are the oar probe agent

        OAR-SYSTEM-APPEND-MARKER always be brief"
      `);
      // /compact runs as its own turn through the same stdin channel…
      const compact = promptTurn(session, "/compact");
      await compact.outcome;
      // …and the prompt configuration must still govern the NEXT request.
      const after = promptTurn(session, "and after compaction?");
      await after.outcome;
      // Compaction must not disturb the configured prompt: identical scrub.
      expect(scrubSystem(lastAgentSystem(capture.systems))).toBe(before);
      await session.dispose();
    } finally {
      await env.stop();
    }
  }, 120_000);

  test("contextUsage() returns a well-formed snapshot after a turn", async () => {
    const env = await startClaudeAimock();
    try {
      const runtime = defineRuntime({ id: "claude-aimock", session: claudeSession, installation: claudeInstallation });
      const session = await runtimeUnderTest(runtime, env.env).startSession();
      const turn = promptTurn(session, "say hi");
      await turn.outcome;
      assertContextUsage(session.contextUsage?.());
      await session.dispose();
    } finally {
      await env.stop();
    }
  }, 60_000);
});
