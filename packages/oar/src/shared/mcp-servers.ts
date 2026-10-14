import { sessionCredentialRedactor } from "./credential-redactor.js";
import { UnsupportedOptionError } from "../contracts/errors.js";
import type { McpServer } from "../contracts/session.js";

/*
 * Runtime-independent handling of `SessionOptions.mcpServers`: the checks
 * every runtime that attaches them shares, and the known-credential rule
 * shared with session records and errors.
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
 * Server names some runtimes drop without a word (#395): JavaScript object
 * members their configuration parsers do not keep. claude 2.1.299 drops all
 * five, kimi, opencode and claude 2.1.296 drop `__proto__`, and grok never
 * announces any of them; the Claude Agent SDK refuses them since 0.3.299.
 * Refused on every runtime, codex and pi included, so one rule holds.
 */
export const RESERVED_MCP_SERVER_NAMES: ReadonlySet<string> = new Set(["__proto__", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__"]);

/**
 * Throw on a list no runtime can attach as given: an empty name, or a name
 * given twice (each runtime keys its servers by name, so the later entry
 * would silently replace the earlier one), a plain error; or a reserved name,
 * an `UnsupportedOptionError` on `mcpServers` as runtimes would drop it. The
 * error names the value.
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
    if (RESERVED_MCP_SERVER_NAMES.has(name)) {
      throw new UnsupportedOptionError("mcpServers", `mcpServers name ${JSON.stringify(name)} is reserved: some runtimes drop a server so named without a word`);
    }
    seen.add(name);
  }
}

/** The same credential-name, length and path rules used for retained session records. */
export function mcpCredentialRedactor(servers: readonly McpServer[] | undefined): (text: string) => string {
  return sessionCredentialRedactor({ mcpServers: servers ?? [] }).redact;
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
