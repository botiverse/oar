import type { TrialCase } from "../runner.js";

/**
 * DRAFT SCAFFOLD — shared session behavior cases land here once the session
 * contract settles. Planned judgments, driven through the mock runtime first:
 * - a prompt yields turn_started … turn_ended framing with one terminal outcome
 * - event envelopes are attributable (sessionId/turnId) and seq is monotonic
 * - abort settles the outcome as aborted exactly once
 * - observers are isolated: a throwing observer must not affect the run
 */
export const sessionCases: readonly TrialCase[] = [];
