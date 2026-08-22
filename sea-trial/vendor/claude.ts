import type { TrialCase } from "../harness/runner.js";
import { startClaudeAimock } from "../harness/aimock.js";
import { runtimeUnderTest } from "../harness/subject.js";

/**
 * Vendor-specific behavior: what the REAL claude harness does at error edges,
 * driven by a scripted provider. These need the full environment but assert
 * claude's own semantics, so they live beside — not inside — the shared suite.
 *
 * Pinned by live observation (2026-08-22, claude 2.1.237):
 * - a non-retryable 4xx fails the turn fast; the result frame carries
 *   is_error=true with subtype "success" (!) and the error text in `result`
 * - a persistent 401 is retried SILENTLY: no stream-json output at all, no
 *   settlement within 25s. That hang class is documented here and guarded in
 *   applications by observeStalls — asserting it as a test would just be a
 *   slow timeout, so it stays an observation, not a case.
 */
export const claudeVendorCases: readonly TrialCase[] = [
  {
    id: "claude.invalid-request-fails-fast",
    requires: ["installation", "session"],
    async run(subject) {
      const env = await startClaudeAimock((mock) => {
        mock.onMessage(/[\s\S]*/u, {
          error: { message: "max_tokens exceeds model limit", type: "invalid_request_error" },
          status: 400,
        });
      });
      try {
        // Own subject over the same runtime, scoped to THIS case's scripted
        // provider via per-session env — safe to run concurrently with the
        // shared suite.
        const session = await runtimeUnderTest(subject.runtime, env.env).startSession();
        const result = session.prompt("hello");
        if (result.kind !== "turn") {
          throw new Error("expected a turn");
        }
        const outcome = await result.turn.outcome;
        if (outcome.kind !== "failed" || !outcome.reason.includes("400")) {
          throw new Error(`expected fast failure carrying the API error, got ${JSON.stringify(outcome)}`);
        }
        await session.dispose();
      } finally {
        await env.stop();
      }
    },
  },
];
