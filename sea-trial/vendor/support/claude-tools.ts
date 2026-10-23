import { setTimeout as sleep } from "node:timers/promises";
import { expect } from "vitest";
import type { Session } from "../../../packages/oar/src/index.js";
import { record } from "../../harness/trace.js";
import { runTurn } from "./asserts.js";
import { asRecord, asRecordList } from "../../../packages/oar/src/shared/json.js";
import type { RawProviderRequest, startClaudeAimock } from "../../harness/aimock.js";

function textParts(content: unknown): readonly string[] {
  return typeof content === "string" ? [content] : asRecordList(content)
    .flatMap((part) => part.type === "text" && typeof part.text === "string" ? [part.text] : []);
}

/**
 * Claude's provider-side MCP catalog: schemas in `tools` and names available
 * through ToolSearch. Fold only the native deferred-tool announcements, in
 * message order; old calls, search results and ordinary mentions are history.
 * A withdrawn deferred name can still have a previously loaded schema in
 * `tools`. Keep those observations separate.
 */
export function claudeMcpCatalog(body: unknown): { readonly schemas: readonly string[]; readonly searchable: readonly string[] } {
  const request = asRecord(body);
  const schemas = asRecordList(request?.tools).flatMap((tool) =>
    typeof tool.name === "string" && tool.name.startsWith("mcp__") ? [tool.name] : []);
  const searchable = new Set<string>();
  const announcements = [
    ...textParts(request?.system),
    ...asRecordList(request?.messages).flatMap((message) =>
      message.role === "system" || message.role === "user" ? textParts(message.content) : []),
  ];
  for (const text of announcements) {
    for (const match of text.matchAll(/(?:^|\n)The following deferred tools are (?<state>now available via ToolSearch|no longer available)[^\n]*\n(?<names>[^\n]+(?:\n[^\n]+)*)/gu)) {
      for (const name of (match.groups?.names ?? "").split("\n")) {
        if (!/^mcp__[\w.-]+$/u.test(name)) { continue; }
        if (match.groups?.state === "now available via ToolSearch") {
          searchable.add(name);
        } else {
          searchable.delete(name);
        }
      }
    }
  }
  return { schemas: [...new Set(schemas)].toSorted(), searchable: [...searchable].toSorted() };
}

function modelRequests(raw: readonly RawProviderRequest[]): readonly unknown[] {
  return raw.filter(({ path }) => /^\/v1\/messages(?:\?|$)/u.test(path)).map(({ body }) => body);
}

/** The main request for this prompt, excluding startup probes, token counts and later tool rounds. */
export function claudePromptRequest(raw: readonly RawProviderRequest[], prompt: string): unknown {
  return modelRequests(raw).find((body) => {
    const messages = asRecordList(asRecord(body)?.messages);
    const lastAssistant = messages.findLastIndex((message) => message.role === "assistant");
    return messages.slice(lastAssistant + 1).some((message) =>
      message.role === "user" && textParts(message.content).includes(prompt));
  });
}

function toolResults(body: unknown): readonly Record<string, unknown>[] {
  return asRecordList(asRecord(body)?.messages)
    .filter((message) => message.role === "user")
    .flatMap((message) => asRecordList(message.content))
    .filter((part) => part.type === "tool_result");
}

/** The first model request after this tool call returns; unrelated traffic cannot move this observation. */
export function claudeToolResultRequest(raw: readonly RawProviderRequest[], id: string): unknown {
  return modelRequests(raw).find((body) => toolResults(body).some((part) => part.tool_use_id === id));
}

/** The provider-side result of a native tool call, before aimock normalizes it. */
export function claudeToolResult(raw: readonly RawProviderRequest[], id: string): unknown {
  return toolResults(claudeToolResultRequest(raw, id)).find((part) => part.tool_use_id === id)?.content;
}

/** A server-side list request does not prove the client has applied its response. */
export async function awaitClaudeMcpCatalog(session: Session,
  env: Awaited<ReturnType<typeof startClaudeAimock>>, expected: readonly string[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (let attempt = 0; Date.now() < deadline; attempt += 1) {
    const marker = `CATALOG_READY_${String(attempt)}`;
    // A failed native turn is a test failure, not a condition to retry.
    // oxlint-disable-next-line no-await-in-loop -- Observe the native asynchronous catalog before the business turn.
    expect(await runTurn(session, marker)).toEqual({ kind: "completed" });
    const catalog = claudeMcpCatalog(claudePromptRequest(env.raw, marker));
    record({ kind: "claude_mcp_catalog_readiness", attempt, catalog });
    if (JSON.stringify(catalog.searchable) === JSON.stringify(expected.toSorted())) { return; }
    // oxlint-disable-next-line no-await-in-loop -- Bounded sampling of provider-visible state, not an adapter delay.
    await sleep(50);
  }
  throw new Error("Claude did not expose the replacement MCP catalog within 10 seconds");
}
