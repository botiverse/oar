/**
 * What fills a session's context window, by the runtime's own categories,
 * read now (`Session.contextBreakdown()`). A reading the host asks for, like
 * an inventory: it changes nothing in the session, so it enters no record.
 * `contextUsage()` stays the fold of what the runtime reported on its own.
 */
export interface ContextBreakdown {
  /** Tokens in the context now: the sum of the `used` categories. */
  readonly tokens: number;
  /** The window the categories fill: every category but the `deferred` ones sums to it. */
  readonly contextWindow: number;
  /** In the runtime's order. */
  readonly categories: readonly ContextCategory[];
}

export interface ContextCategory {
  /** The runtime's own name for it (claude: `System prompt`, `MCP tools`, `Autocompact buffer`); OAR does not rename them. */
  readonly name: string;
  readonly tokens: number;
  /**
   * `used`: in the context now. `deferred`: available, loaded only when used,
   * and not counted in `tokens`. `reserved`: kept free by the runtime (claude's
   * autocompact buffer). `free`: unused. `unknown`: a kind OAR does not
   * recognize, kept rather than dropped.
   */
  readonly kind: "used" | "deferred" | "reserved" | "free" | "unknown";
  /** The entries that make it up, when the runtime itemizes it (memory files by path, MCP tools, skills, agents). */
  readonly items?: readonly ContextItem[];
}

export interface ContextItem {
  readonly name: string;
  readonly tokens: number;
}
