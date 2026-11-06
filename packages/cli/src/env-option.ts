import type { SessionOptions } from "@botiverse/oar";

/**
 * Parse repeated `--env KEY=VALUE` occurrences into a session env overlay.
 * A later occurrence wins; `KEY=` sets an empty string. Removal (null) is not
 * expressible on the command line — pass an empty string instead.
 */
export function parseEnvOptions(values: readonly string[] | undefined): SessionOptions["env"] | undefined {
  if (values === undefined || values.length === 0) { return undefined; }
  const env: Record<string, string> = {};
  for (const value of values) {
    const index = value.indexOf("=");
    const key = index === -1 ? value : value.slice(0, index);
    if (key.length === 0 || key.includes("\u0000")) {
      throw new Error(`--env expects KEY=VALUE, got "${value}"`);
    }
    env[key] = index === -1 ? "" : value.slice(index + 1);
  }
  return env;
}

/** Commander collector: every `--env` occurrence appends, none clobber the previous. */
export function collectEnv(value: string, previous: readonly string[]): string[] {
  return [...previous, value];
}
