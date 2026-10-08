import { UnsupportedOptionError } from "../contracts/errors.js";
import type { McpServer } from "../contracts/session.js";

/*
 * Runtime-independent handling of `SessionOptions.mcpServers`: the checks
 * every runtime that attaches them shares, and the credential rule (`env` and
 * `headers` values never reach a record, event or error).
 */

/** The streamable HTTP form of an entry (`type: "http"`); the other form is stdio. */
export type McpHttpServer = Extract<McpServer, { readonly type: "http" }>;
/** The stdio form of an entry: a command the runtime starts. */
export type McpStdioServer = Exclude<McpServer, McpHttpServer>;

export function isHttpMcpServer(server: McpServer): server is McpHttpServer {
  return "type" in server;
}

/** Whether the entry carries a credential: a non-empty `env` (stdio) or `headers` (http). */
export function hasMcpCredentials(server: McpServer): boolean {
  return Object.keys((isHttpMcpServer(server) ? server.headers : server.env) ?? {}).length > 0;
}

/** The given list, or nothing when there is none to attach (absent or empty). */
export function givenMcpServers(servers: readonly McpServer[] | undefined): readonly McpServer[] | null {
  for (const server of servers ?? []) {
    if (!isHttpMcpServer(server)) {
      for (const [key, value] of Object.entries(server.env ?? {})) {
        if (typeof value !== "string") {
          throw new UnsupportedOptionError("mcpServers", `MCP server ${JSON.stringify(server.name)} env.${key} must be a string; null removal is only supported by SessionOptions.env`);
        }
      }
    }
  }
  return servers === undefined || servers.length === 0 ? null : servers;
}

/**
 * Throw on a list no runtime can attach as given: an empty name, or a name
 * given twice (each runtime keys its servers by name, so the later entry
 * would silently replace the earlier one). The error names the value.
 */
export function checkMcpServerNames(servers: readonly McpServer[]): void {
  givenMcpServers(servers);
  const seen = new Set<string>();
  for (const { name } of servers) {
    if (name.length === 0) {
      throw new Error("mcpServers has an entry with an empty name");
    }
    if (seen.has(name)) {
      throw new Error(`mcpServers names ${JSON.stringify(name)} twice; names are unique within a session`);
    }
    seen.add(name);
  }
}

/** Shorter values cannot be a credential, and replacing them would garble the text around them (`code 1`). */
const CREDENTIAL_MIN_LENGTH = 4;

/** Every credential value in the entries: each `env` and `headers` value, longest first. */
function credentialValues(servers: readonly McpServer[]): readonly string[] {
  const values = servers.flatMap((server) => Object.values((isHttpMcpServer(server) ? server.headers : server.env) ?? {}));
  return [...new Set(values.filter((value) => typeof value === "string" && value.length >= CREDENTIAL_MIN_LENGTH))].toSorted((left, right) => right.length - left.length);
}

/**
 * A redactor for text oar reports from a runtime that was given these
 * entries (an error message, a stderr tail): every `env` and `headers` value
 * of at least four characters becomes `[redacted]`. Identity when the
 * entries hold none.
 */
export function mcpCredentialRedactor(servers: readonly McpServer[] | undefined): (text: string) => string {
  const values = credentialValues(servers ?? []);
  if (values.length === 0) {
    return (text) => text;
  }
  return (text) => values.reduce((redacted, value) => redacted.replaceAll(value, "[redacted]"), text);
}

/**
 * `error` with its message and stack passed through `redact`, and so every
 * error down its `cause` chain (a `RuntimeFailureError` keeps the agent's
 * error there); in place, so classes and fields stay. Anything else as it is.
 */
export function redactError(error: unknown, redact: (text: string) => string): unknown {
  const seen = new Set<Error>();
  for (let current: unknown = error; current instanceof Error && !seen.has(current); current = current.cause) {
    seen.add(current);
    current.message = redact(current.message);
    if (current.stack !== undefined) {
      current.stack = redact(current.stack);
    }
  }
  return error;
}
