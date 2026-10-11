import type { FailedTurn } from "./failure.js";

/** How a turn ended; `failed` is a `FailedTurn`, tagged by its `failure`. */
export type TurnOutcome = {
  readonly kind: "completed";
  /**
   * The runtime's native structured result, when it reports one (Claude's
   * result.structured_output, Grok's prompt _meta.structuredOutput). Passed
   * through without parsing or validation; absence differs from a reported
   * null. Even with outputSchema, Claude can complete without this field
   * when the model does not supply one; hosts must check for it.
   * Codex returns text instead. See the runtime page for validation guarantees.
   */
  readonly structuredOutput?: unknown;
} | { readonly kind: "aborted" } | FailedTurn;
