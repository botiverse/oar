import type { SessionOptions } from "@botiverse/oar";

/** Commander collector for a repeatable `--env KEY=VALUE` option. */
export function collectEnvPair(value: string, previous: readonly string[]): string[] {
  return [...previous, value];
}

/**
 * Parse collected `--env KEY=VALUE` pairs into a session environment overlay
 * (strings override; the CLI cannot express null removal). Undefined when no
 * pair was given, so callers can leave the option out of the read entirely.
 */
export function envOverlayFromPairs(pairs: readonly string[], error: (message: string) => never): SessionOptions["env"] | undefined {
  if (pairs.length === 0) {
    return undefined;
  }
  const overlay: Record<string, string> = {};
  for (const pair of pairs) {
    const separator = pair.indexOf("=");
    const name = separator === -1 ? pair : pair.slice(0, separator);
    if (separator === -1 || name.length === 0 || name.includes("\0") || pair.includes("\0")) {
      error(`--env expects KEY=VALUE with a non-empty KEY, got ${JSON.stringify(pair)}`);
    }
    overlay[name] = pair.slice(separator + 1);
  }
  return overlay;
}
