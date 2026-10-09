import { readFileSync } from "node:fs";
import { asRecord, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";

/*
 * claude's token frames for #282. Real frames, claude 2.1.292 (haiku),
 * recorded 2026-10-09 (only quota state, home and temp paths redacted;
 * modelUsage, parent_tool_use_id, message ids and usage verbatim):
 * - claude-usage-subagent-compact: one process; a turn that runs one Task
 *   subagent (`echo SUB_OK`), a plain "Reply with just: OK" turn, then /compact.
 * - claude-usage-resume: the next process, `--resume` of that session, one
 *   "Reply with just: OK" turn.
 * The `get_usage` answer is SYNTHETIC: shaped per claude 2.1.289's schema,
 * its `session.model_usage` the previous process's last `result.modelUsage`,
 * which a live read found identical. Replace it with a recorded one.
 */

export function claudeFrames(name: string): JsonRecord[] {
  return readFileSync(new URL(`../replay/fixtures/claude-${name}.raw.jsonl`, import.meta.url), "utf8")
    .split("\n")
    .flatMap((line) => {
      const frame = asRecord(parseJson(line));
      return frame === null ? [] : [frame];
    });
}

export const firstProcess = claudeFrames("usage-subagent-compact");
export const resumedProcess = claudeFrames("usage-resume");
export const resultsOf = (lines: readonly JsonRecord[]): JsonRecord[] => lines.filter((frame) => frame.type === "result");

/** The previous process's last running total: what `get_usage` answers on the resume. */
export const savedModelUsage: unknown = resultsOf(firstProcess).at(-1)?.modelUsage;

/** Account data the SYNTHETIC `get_usage` answer carries beside the session totals; none may reach a record. */
export const privateUsageValues = ["oar-private-plan", "2026-10-09T20:00:00Z", "777777", "123456", "oar-private-agent"];

/** SYNTHETIC `get_usage` control_response (schema 2.1.289): the session totals beside account data. */
export function getUsageAnswer(requestId: unknown, modelUsage: unknown): JsonRecord {
  return {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response: {
        session: { total_cost_usd: 0.055, total_api_duration_ms: 1, total_duration_ms: 1, total_lines_added: 0, total_lines_removed: 0, model_usage: modelUsage },
        subscription_type: "oar-private-plan",
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 41, resets_at: "2026-10-09T20:00:00Z" }, extra_usage: { is_enabled: true, monthly_limit: 777_777, used_credits: 123_456, utilization: 16 } },
        behaviors: { day: { request_count: 3, session_count: 1, behaviors: [], agents: [{ name: "oar-private-agent", pct: 100 }], skills: [], plugins: [], mcp_servers: [] }, week: null },
      },
    },
  };
}
