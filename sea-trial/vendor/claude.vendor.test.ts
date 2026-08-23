import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import type { SessionEvent } from "../../packages/oar/src/contracts/session.js";
import { claudeInstallation, claudeSession, defineRuntime } from "../../packages/oar/src/index.js";
import { claudeAccountUsage } from "../../packages/oar/src/runtimes/claude/index.js";
import { withProcessEnv } from "./env.js";
import { startClaudeAimock } from "../harness/aimock.js";
import { runtimeUnderTest } from "../harness/subject.js";

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
      const result = session.prompt("hello");
      if (result.kind !== "turn") {
        throw new Error("expected a turn");
      }
      await expect(result.turn.outcome).resolves.toMatchInlineSnapshot(`
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
        if (installation.kind !== "available") {
          throw new Error("claude unavailable");
        }
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
      const result = session.prompt("hello");
      if (result.kind !== "turn") {
        throw new Error("expected a turn");
      }
      const settled = await Promise.race([
        result.turn.outcome.then(() => true),
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
});
