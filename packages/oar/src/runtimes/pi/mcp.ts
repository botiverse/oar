import path from "node:path";
import type { AgentSession as PiAgentSession, InlineExtension, McpServerConfig } from "@earendil-works/pi-coding-agent";
import type { McpServer, SessionOptions } from "../../contracts/session.js";
import { checkMcpServerNames, givenMcpServers, isHttpMcpServer, mcpCredentialRedactor } from "../../shared/mcp-servers.js";

/*
 * SessionOptions.mcpServers on pi: the SDK's own MCP support, as the pi CLI
 * runs it (pi-coding-agent 1.0.4). pi's MCP client is the built-in `mcp`
 * extension (`createMcpExtension`, on `@earendil-works/pi-mcp`), which the
 * CLI loads by default and the SDK path oar opens does not; an extension
 * registers a server for one session with `pi.registerMcpServer(name,
 * config)`, the `mcpServers` entry shape of pi's `mcp.json`. So a session
 * given servers gets two inline extensions: the MCP extension with no
 * `mcp.json` of its own (oar's pi never loaded the user's, with or without
 * this option), and one registering the entries. The MCP extension connects
 * them on `session_start` and closes them on `session_shutdown`, events the
 * pi CLI's session host emits and oar's opener otherwise does not: such a
 * session binds its extensions after it is created (`bindExtensions`, so
 * the user's extensions see `session_start` too) and emits
 * `session_shutdown` before it is disposed. The first prompt waits up to
 * 10 s for the servers to connect. Tools are `mcp__<name>__<tool>` declared to the model
 * directly (`exposure: "direct"`): pi's default, `codemode`, reaches them
 * only from the codemode extension, which oar does not load either.
 *
 * Measured against a scripted provider: the vendor test
 * (sea-trial/vendor/mcp-servers.vendor.test.ts) and docs/runtimes/pi.md.
 */

/** The names pi takes (`validateMcpServerConfig`); its tool namespace folds `-` into `_`, so `a-b` and `a_b` would be one server. */
const PI_MCP_SERVER_NAME = /^[\w-]+$/u;

/**
 * A value as pi reads it literally: pi resolves `env` and `headers` values
 * (`resolveConfigValue`), running one that starts with `!` as a shell
 * command and interpolating `$NAME`; `$$` and `$!` are its escapes for a
 * literal `$` and `!`.
 */
export function piLiteralConfigValue(value: string): string {
  return value.replaceAll(/[$!]/gu, (character) => `$${character}`);
}

function literalValues(values: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, piLiteralConfigValue(value)]));
}

/**
 * One entry as pi's MCP server config: http `{type, url, headers}`, stdio
 * `{type, command, args, env}` whose env is `SessionOptions.env` with the
 * entry's on top (pi starts it with the host's environment under that, like
 * the bash tool's). Every value literal, every tool declared directly.
 */
export function piMcpServerConfig(server: McpServer, sessionEnv: Readonly<Record<string, string>> = {}): McpServerConfig {
  if (isHttpMcpServer(server)) {
    return { type: "http", url: server.url, ...(server.headers === undefined ? {} : { headers: literalValues(server.headers) }), exposure: "direct" };
  }
  const env = { ...sessionEnv, ...server.env };
  return {
    type: "stdio",
    command: server.command,
    args: [...server.args ?? []],
    ...(Object.keys(env).length === 0 ? {} : { env: literalValues(env) }),
    exposure: "direct",
  };
}

/** Throw on a list pi cannot register as given: an empty or repeated name, one pi refuses, or two pi would fold into one. */
function checkPiMcpServerNames(servers: readonly McpServer[]): void {
  checkMcpServerNames(servers);
  const namespaces = new Map<string, string>();
  for (const { name } of servers) {
    if (!PI_MCP_SERVER_NAME.test(name)) {
      throw new Error(`pi registers no MCP server named ${JSON.stringify(name)}: its names match ${PI_MCP_SERVER_NAME.source}`);
    }
    const namespace = name.replaceAll("-", "_");
    const other = namespaces.get(namespace);
    if (other !== undefined) {
      throw new Error(`pi would give the MCP servers ${JSON.stringify(other)} and ${JSON.stringify(name)} one tool namespace (mcp__${namespace})`);
    }
    namespaces.set(namespace, name);
  }
}

/** The session's MCP extensions, and how to tell that pi loaded them. */
export interface PiMcpExtensions {
  readonly extensions: readonly InlineExtension[];
  /**
   * Throws when pi failed to load either extension or refused a
   * registration (another extension already holds the name), given the
   * errors of pi's extension load: the session would run without the server.
   */
  check(loadErrors: readonly { readonly path: string; readonly error: string }[]): void;
  /** Start the created session's extensions (`session_start`), which connects the servers; `releasePiMcp` stops them. */
  start(session: PiAgentSession): Promise<void>;
}

/** Sessions whose MCP extension was started, so their dispose emits `session_shutdown` first. */
const started = new WeakSet<PiAgentSession>();

/**
 * Close the session's MCP connections (stdio servers exit) before it is
 * disposed: pi's `session_shutdown`, emitted only for a session `start`
 * bound; a no-op for any other.
 */
export async function releasePiMcp(session: PiAgentSession): Promise<void> {
  if (started.delete(session)) {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  }
}

const MCP_EXTENSION = "oar-mcp";
const REGISTER_EXTENSION = "oar-mcp-servers";

/**
 * The inline extensions attaching `options.mcpServers` to a pi session, or
 * null when it has none. Throws before anything opens on a name pi would
 * refuse or fold into another. pi's MCP server log goes to `<agentDir>/mcp.log`.
 */
export async function piMcpExtensions(options: SessionOptions, agentDir: string): Promise<PiMcpExtensions | null> {
  const servers = givenMcpServers(options.mcpServers);
  if (servers === null) {
    return null;
  }
  checkPiMcpServerNames(servers);
  const sdk = await import("@earendil-works/pi-coding-agent");
  const redact = mcpCredentialRedactor(servers);
  const failures: string[] = [];
  const register: InlineExtension = (pi) => {
    for (const server of servers) {
      try {
        pi.registerMcpServer(server.name, piMcpServerConfig(server, options.env));
      } catch (error) {
        failures.push(redact(error instanceof Error ? error.message : String(error)));
      }
    }
  };
  return {
    extensions: [
      { name: MCP_EXTENSION, factory: sdk.createMcpExtension({ loadConfig: () => ({ servers: [], errors: [] }), logPath: path.join(agentDir, "mcp.log") }), hidden: true },
      { name: REGISTER_EXTENSION, factory: register, hidden: true },
    ],
    check: (loadErrors) => {
      const ours = new Set([`<inline:${MCP_EXTENSION}>`, `<inline:${REGISTER_EXTENSION}>`]);
      failures.push(...loadErrors.filter((entry) => ours.has(entry.path)).map((entry) => redact(entry.error)));
      if (failures.length > 0) {
        throw new Error(`pi did not register the session's MCP servers: ${failures.join("; ")}`);
      }
    },
    start: async (session) => {
      started.add(session);
      await session.bindExtensions({});
    },
  };
}
