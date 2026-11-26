import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { asRecord } from "../../shared/json.js";

/**
 * One tool the OPENED Pi session reports, in the only terms OAR will trust:
 * the name the model calls and the source Pi itself says registered it
 * ([src] pi-coding-agent `ToolInfo.sourceInfo`, read back from that session).
 *
 * Nothing here is inferred from a tool name, a version or a file on disk: a
 * session that reports no tool list makes OAR claim no extension at all.
 */
export interface PiLoadedTool {
  readonly name: string;
  /** The native source path Pi reported: `builtin:<name>` for its own tools, a file for anything an extension added. */
  readonly path: string;
  /** What Pi names as the source (`builtin`, an extension file's stem, a package id). */
  readonly source: string;
}

/** Prefix Pi uses for its own tools ([src] `BUILTIN_PATH_PREFIX`). */
const BUILTIN_PATH = "builtin:";

/** The session's report, reduced to the three facts OAR reads. Entries it cannot read are dropped, never repaired. */
export function piLoadedTools(tools: readonly ToolInfo[]): readonly PiLoadedTool[] {
  const loaded: PiLoadedTool[] = [];
  for (const tool of tools) {
    const info = tool.sourceInfo;
    if (typeof tool.name !== "string" || typeof info.path !== "string" || typeof info.source !== "string") {
      continue;
    }
    loaded.push({ name: tool.name, path: info.path, source: info.source });
  }
  return loaded;
}

/**
 * The same report as the native RPC child sends it over its private pipe
 * (`{ type: "tools", tools: [{ name, path, source }] }`, read from the child's
 * own `getAllTools`). An entry OAR cannot read is dropped, and a message that
 * is not a report is no report: the caller then claims no extension at all.
 */
export function piReportedTools(value: unknown): readonly PiLoadedTool[] {
  const record = asRecord(value);
  const reported: unknown = record?.tools;
  if (!Array.isArray(reported)) {
    return [];
  }
  const loaded: PiLoadedTool[] = [];
  for (const entry of reported) {
    const tool = asRecord(entry);
    if (typeof tool?.name === "string" && typeof tool.path === "string" && typeof tool.source === "string") {
      loaded.push({ name: tool.name, path: tool.path, source: tool.source });
    }
  }
  return loaded;
}

/** The identity of the one extension-provided tool `name` names, or null. */
export interface PiExtensionIdentity {
  readonly tool: string;
  readonly source: string;
}

/**
 * The extension identity of a tool the session reported, or null when OAR
 * cannot confirm one: no report at all, no such tool, the name listed twice
 * (two sources for one name is not a verified identity), or Pi's own builtin.
 * A null means the caller reports no extension fact — never a guess from the
 * name it saw in the call.
 */
export function piExtensionIdentity(tools: readonly PiLoadedTool[] | undefined, name: string): PiExtensionIdentity | null {
  if (tools === undefined) {
    return null;
  }
  const matches = tools.filter((tool) => tool.name === name);
  const only = matches.length === 1 ? matches[0] : undefined;
  if (only === undefined || only.path.startsWith(BUILTIN_PATH) || only.source === "" || only.source === "builtin") {
    return null;
  }
  return { tool: only.name, source: only.source };
}

/**
 * The fold's checklist input for a session that can read its own tool list.
 * A read that throws, or a report with no entries, is no report at all: the
 * fold then makes no extension claim rather than guessing one.
 */
export function piLoadedToolsExtra(read: () => readonly ToolInfo[]): { readonly loadedTools?: readonly PiLoadedTool[] } {
  try {
    const tools = piLoadedTools(read());
    return tools.length === 0 ? {} : { loadedTools: tools };
  } catch { return {}; }
}
