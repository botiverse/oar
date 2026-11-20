/** Current context fullness, borrowed from pi's shape because it already models the hard case: `tokens` is null when unknown (right after compaction, before the next model response), and `percent` follows. */
export interface ContextUsage {
  readonly tokens: number | null;
  readonly contextWindow: number | null;
  readonly percent: number | null;
}

/**
 * Whether `Session.contextUsage()` reliably reports trustworthy `tokens` and
 * `contextWindow` by the end of each normally completed root turn (fresh and
 * resumed sessions alike; aborted turns are not promised, and earlier readings
 * are a bonus). A turn that compacted may end with `tokens: null`: the context
 * is unknown until the next model response, as `ContextUsage` says, so a
 * compaction-only turn (a manual compact) never reports it.
 */
export interface ContextUsageCapability {
  readonly tokens: boolean;
  readonly contextWindow: boolean;
}
