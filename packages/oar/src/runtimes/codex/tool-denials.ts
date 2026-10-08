import { UnsupportedOptionError } from "../../contracts/errors.js";
import type { SessionOptions } from "../../contracts/session.js";
import type { AppServerClient } from "./app-server-client.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";

/** No builtin deny channel in app-server. MCP names must identify a server
 * and its native tool; the server is resolved against effective config. */
export function validateCodexToolDenials(options: SessionOptions): void {
  const unsupported = (options.disallowedTools ?? []).filter((name) => !/^mcp__[\w]+__.+$/u.test(name));
  if (unsupported.length > 0) {
    throw new UnsupportedOptionError("disallowedTools", `codex only filters MCP tools qualified as mcp__server__tool; built-in or unqualified names have no native deny channel: ${JSON.stringify(unsupported)}`);
  }
}

/** Keep existing native denies, emit only per-server disabled_tools overrides.
 * No credentials or other user configuration from config/read are copied. */
export function codexToolDenialsConfig(options: SessionOptions, effective: JsonRecord): JsonRecord {
  validateCodexToolDenials(options);
  const configured = asRecord(effective.mcp_servers) ?? {};
  const servers = [...new Set([...Object.keys(configured), ...(options.mcpServers ?? []).map((server) => server.name)])];
  const groups = new Map<string, string[]>();
  const unsupported: string[] = [];
  for (const name of options.disallowedTools ?? []) {
    // Non-word server names are normalized by native tool qualification;
    // don't guess at them or choose one of two possible server prefixes.
    const matching = servers.filter((server) => /^\w+$/u.test(server) && name.startsWith(`mcp__${server}__`));
    const server = matching.length === 1 ? matching[0] : undefined;
    if (server === undefined) {
      unsupported.push(name);
      continue;
    }
    const tool = name.slice(`mcp__${server}__`.length);
    if (tool.length === 0) {
      unsupported.push(name);
      continue;
    }
    const tools = groups.get(server) ?? [];
    tools.push(tool);
    groups.set(server, tools);
  }
  if (unsupported.length > 0) {
    throw new UnsupportedOptionError("disallowedTools", `codex cannot identify one configured MCP server with an unmodified native namespace for: ${JSON.stringify(unsupported)}`);
  }
  return Object.fromEntries([...groups].map(([server, names]) => {
    const prior = asRecord(configured[server])?.disabled_tools;
    if (prior !== undefined && prior !== null && (!Array.isArray(prior) || prior.some((name) => typeof name !== "string"))) {
      throw new UnsupportedOptionError("disallowedTools", `codex cannot preserve the existing disabled_tools for server ${JSON.stringify(server)} while disabling ${JSON.stringify(names)}`);
    }
    const previous = Array.isArray(prior) ? prior.filter((name: unknown): name is string => typeof name === "string") : [];
    return [server, { disabled_tools: [...new Set([...previous, ...names])] }];
  }));
}

/** Add denials without dropping session MCP launch configuration. */
export function withCodexToolDenials(params: JsonRecord, denials: JsonRecord): JsonRecord {
  const config = asRecord(params.config) ?? {};
  const servers = { ...asRecord(config.mcp_servers) };
  for (const [server, denied] of Object.entries(denials)) {
    servers[server] = { ...asRecord(servers[server]), ...asRecord(denied) };
  }
  return { ...params, config: { ...config, mcp_servers: servers } };
}

/** Resolve session filters before thread creation; release the process on refusal. */
export async function prepareCodexToolDenials(client: AppServerClient, options: SessionOptions, params: JsonRecord): Promise<JsonRecord> {
  if ((options.disallowedTools?.length ?? 0) === 0) {
    return params;
  }
  try {
    const effective = await client.request("config/read", { cwd: options.cwd, includeLayers: false });
    return withCodexToolDenials(params, codexToolDenialsConfig(options, asRecord(effective.config) ?? {}));
  } catch (error) {
    client.kill();
    await client.exited;
    throw error;
  }
}
