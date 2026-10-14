import type { RefusableSessionOption, RefusedSessionOptions } from "../contracts/runtime.js";
import type { SessionOptions } from "../contracts/session.js";
import { UnsupportedOptionError } from "../contracts/errors.js";
import { hasMcpCredentials } from "./mcp-servers.js";

/** The names of the `mcpServers` entries carrying a credential: `env` on a stdio entry, `headers` on an http one. */
function credentialEntries(options: SessionOptions): readonly string[] {
  return (options.mcpServers ?? []).filter((server) => hasMcpCredentials(server)).map((server) => server.name);
}

/** Whether `options` gives `key`: any defined value (including an empty schema), a non-empty map for `env`, a non-empty list for list options, an entry carrying a credential for `mcpServerCredentials`. */
export function sessionOptionGiven(options: SessionOptions, key: RefusableSessionOption): boolean {
  if (key === "env") {
    return options.env !== undefined && Object.keys(options.env).length > 0;
  }
  if (key === "mcpServerCredentials") {
    return credentialEntries(options).length > 0;
  }
  if (key === "mcpServers" || key === "disallowedTools" || key === "launchArgs" || key === "additionalDirectories") {
    return options[key] !== undefined && options[key].length > 0;
  }
  return options[key] !== undefined;
}

/**
 * Reject an open that gives an option the runtime declares refused: an
 * `UnsupportedOptionError` naming it (`mcpServers` for
 * `mcpServerCredentials`), with the declared reason, followed by the refused
 * values for `disallowedTools` and the entries' names for
 * `mcpServerCredentials`.
 */
export function refuseSessionOptions(refused: RefusedSessionOptions, options: SessionOptions): void {
  for (const key of ["systemPrompt", "appendSystemPrompt", "env", "mcpServers", "mcpServerCredentials", "disallowedTools", "launchArgs", "serviceTier", "additionalDirectories", "outputSchema", "name"] as const) {
    const reason = refused[key];
    if (reason === undefined || !sessionOptionGiven(options, key)) {
      continue;
    }
    if (key === "mcpServerCredentials") {
      throw new UnsupportedOptionError("mcpServers", `${reason}: ${JSON.stringify(credentialEntries(options))}`);
    }
    throw new UnsupportedOptionError(key, key === "disallowedTools" ? `${reason}: ${JSON.stringify(options.disallowedTools)}` : reason);
  }
}

/**
 * A blank SessionOptions.name, or one with a NUL character, is refused before
 * anything starts, as invalid `additionalDirectories` are: claude and pi
 * would open unnamed without a word, codex would refuse a blank one only
 * after the thread opened (pi's own `--name` refuses it the same way), and
 * no command line can carry a NUL.
 */
export function checkSessionName(options: SessionOptions): void {
  if (options.name !== undefined && (options.name.trim().length === 0 || options.name.includes("\0"))) {
    throw new UnsupportedOptionError("name", "name must not be blank or contain NUL characters");
  }
}
