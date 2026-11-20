import type { RawEvent, RuntimeEventBody } from "../contracts/session.js";

export type McpStartupStatus = Extract<RuntimeEventBody, { kind: "mcp_server_startup" }>["status"];

/** Latest reported startup state of each server in one session's record stream. A missing name is unknown. */
export function mcpStartupOf(records: readonly RawEvent[], sessionId: string): ReadonlyMap<string, McpStartupStatus> {
  const statuses = new Map<string, McpStartupStatus>();
  for (const record of records) {
    if (record.kind !== "frame" || record.sessionId !== sessionId || record.agentPath.length > 0) { continue; }
    for (const event of record.body.events) {
      if (event.kind === "mcp_server_startup") { statuses.set(event.server, event.status); }
    }
  }
  return statuses;
}
