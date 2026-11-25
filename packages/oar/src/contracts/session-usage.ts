import type { TokenTotals } from "./records.js";

/**
 * This session's token total, counted from when it opened: everything the
 * runtime reports it spent, subagents and compaction included where the
 * runtime counts them (claude's `modelUsage`). With a per-agent breakdown
 * when sub-agents reported or part of the total is no agent's:
 * deduplicated, `byAgent` plus `unattributed` sum to `total`. A derived
 * child session (own `sessionId`, in `graph()`) reports independent usage
 * in its own records, added once by `withChildren`. Grok child ledgers stay
 * native-only because they can overlap the root; late background children
 * can be missing from its total. Independent automatic root turns are counted.
 */
export interface SessionUsage {
  /** Null until the runtime has reported token totals, never a guessed zero (kimi's ACP surface reports context only). */
  readonly total: TokenTotals | null;
  /** Present only when more than the root agent reported tokens, or part of `total` is `unattributed`. */
  readonly byAgent?: readonly { readonly agentPath: readonly string[]; readonly tokens: TokenTotals }[];
  /** What `total` includes that no `byAgent` entry accounts for (claude's subagents, sidechains and compaction, which its stream does not attribute per agent): `total` less every entry, never split by estimate. Absent when the agents account for all of it. */
  readonly unattributed?: TokenTotals;
  /** `total` plus each derived session's independently reported token total, nested children too, each counted once. Grok's child ledgers stay native-only to avoid possible overlap; this does not establish that the root counted every child. Absent when no child session reported independent usage, and while `total` is null. */
  readonly withChildren?: TokenTotals;
}
