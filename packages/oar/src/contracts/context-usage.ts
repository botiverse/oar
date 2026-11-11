/* oxlint-disable import/prefer-default-export -- the package exports names only. */
/** Current context fullness, borrowed from pi's shape because it already models the hard case: `tokens` is null when unknown (right after compaction, before the next model response), and `percent` follows. */
export interface ContextUsage {
  readonly tokens: number | null;
  readonly contextWindow: number | null;
  readonly percent: number | null;
}
