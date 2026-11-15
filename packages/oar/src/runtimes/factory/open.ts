/* oxlint-disable import/max-dependencies -- Open owns native settings, resume identity, MCP mapping and typed refusals. */
import { realpathSync } from "node:fs";
import type { ContextUsage, SessionOptions } from "../../contracts/session.js";
import type { McpServer } from "../../contracts/session-options.js";
import { SessionNotFoundError } from "../../contracts/session-not-found-error.js";
import { UnsupportedOptionError } from "../../contracts/errors.js";
import { ResumeCwdError } from "../../contracts/resume-cwd-error.js";
import { asNumber, asRecord, asRecordList, type JsonRecord } from "../../shared/json.js";
import { sameDirectory } from "../../shared/same-directory.js";
import type { DroidClient, DroidOutcome } from "./client.js";
import { factoryMcpServers } from "./options.js";
import { effortRefusal } from "./settings.js";

const OPEN_TIMEOUT_MS = 120_000;

/** The open request: `initialize_session` for a new session (OAR's YOLO default: `skipPermissionsUnsafe`), `load_session` for a resume. */
export function factoryOpenRequest(options: SessionOptions, servers: readonly McpServer[] | null): { readonly method: string; readonly params: JsonRecord } {
  const mcp = servers === null ? {} : { mcpServers: factoryMcpServers(servers) };
  if (options.resume !== undefined) {
    if (options.systemPrompt !== undefined || options.appendSystemPrompt !== undefined) {
      throw new UnsupportedOptionError(options.systemPrompt === undefined ? "appendSystemPrompt" : "systemPrompt", "droid's load_session takes no system prompt; a resumed session keeps the one it was created with");
    }
    // One message back is enough: the open frame records droid's answer, not the transcript.
    return { method: "droid.load_session", params: { sessionId: options.resume, messageLimit: 1, ...mcp } };
  }
  const append = options.appendSystemPrompt;
  let systemPrompt: JsonRecord = {};
  if (options.systemPrompt !== undefined) {
    systemPrompt = { systemPrompt: append === undefined ? options.systemPrompt : `${options.systemPrompt}\n\n${append}` };
  } else if (append !== undefined) {
    systemPrompt = { systemPrompt: { type: "preset", preset: "droid", append } };
  }
  return { method: "droid.initialize_session", params: {
    machineId: "default", cwd: options.cwd, sessionOriginHint: "sdk", skipPermissionsUnsafe: true,
    ...(options.model === undefined ? {} : { modelId: options.model }),
    ...(options.effort === undefined ? {} : { reasoningEffort: options.effort }),
    ...systemPrompt, ...mcp,
  } };
}

function realDirectory(directory: string): string {
  try { return realpathSync(directory); } catch { return directory; }
}

/** Send the open; an unknown resume id (-32004 ENTITY_NOT_FOUND) is SessionNotFoundError, a session saved for another directory is refused. */
export async function openFactory(client: DroidClient, options: SessionOptions, method: string, params: JsonRecord, markOpen: (outcome: DroidOutcome) => void): Promise<JsonRecord> {
  try {
    const opened = await Promise.race([
      client.request(method, params, markOpen),
      new Promise<never>((_resolve, reject) => { setTimeout(() => { reject(new Error(`droid did not answer ${method} within ${String(OPEN_TIMEOUT_MS / 1000)}s`)); }, OPEN_TIMEOUT_MS).unref(); }),
    ]);
    if (options.resume !== undefined && typeof opened.cwd === "string" && !sameDirectory(realDirectory(opened.cwd), realDirectory(options.cwd))) {
      throw new ResumeCwdError(`droid session ${options.resume} belongs to ${opened.cwd}; resume it from that directory`, {
        sessionId: options.resume, requestedCwd: options.cwd, reason: "other_cwd", savedCwd: opened.cwd,
      });
    }
    return opened;
  } catch (error) {
    const native = asRecord(asRecord(error instanceof Error ? error.cause : null)?.native);
    if (options.resume !== undefined && native?.code === -32_004) {
      throw new SessionNotFoundError(options.resume, `droid has no session ${options.resume}`, { method, native });
    }
    throw effortRefusal(error, options) ?? error;
  }
}


/**
 * OAR's answer to a droid→client request. Nobody sits at a prompt in embedded
 * use: a permission is allowed once, and only once. A standing grant
 * (`proceed_always`, `proceed_auto_run_*`, ...) is never chosen; without
 * `proceed_once` OAR picks an offered `cancel`, and with neither it answers
 * an error rather than a value droid did not offer. Questions are declined.
 */
export function serverReply(method: string, params: JsonRecord): { readonly result: JsonRecord } | { readonly error: { readonly code: number; readonly message: string } } {
  switch (method) {
    case "droid.request_permission": {
      const offered = new Set(asRecordList(params.options).flatMap(option => typeof option.value === "string" ? [option.value] : []));
      const selected = ["proceed_once", "cancel"].find(value => offered.has(value));
      return selected === undefined
        ? { error: { code: -32_602, message: "OAR allows a permission only once; droid offered neither proceed_once nor cancel" } }
        : { result: { selectedOption: selected } };
    }
    case "droid.ask_user": return { result: { cancelled: true, answers: [] } };
    case "droid.pick_options": return { result: { cancelled: true, selectedIds: [] } };
    default: return { error: { code: -32_601, message: `OAR does not handle ${method}` } };
  }
}

/** `droid.get_context_stats` as OAR's context fullness. */
export function contextOf(result: JsonRecord): ContextUsage | null {
  const used = asNumber(result.used);
  const limit = asNumber(result.limit);
  if (used === null || limit === null) { return null; }
  return { tokens: used, contextWindow: limit, percent: limit > 0 ? Math.round((used / limit) * 1000) / 10 : null };
}
