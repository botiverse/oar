import { fileURLToPath } from "node:url";
import type { Session, RawEvent } from "../../packages/oar/src/contracts/session.js";
import { acpSession, type AcpSessionProfile } from "../../packages/oar/src/shared/acp/session.js";

/** The scripted ACP agent (fake-acp-agent.mjs) and the session helpers the ACP tests share. */
export const fixture = fileURLToPath(new URL("fake-acp-agent.mjs", import.meta.url));
const installation = {
  kind: "available",
  via: "executable",
  command: process.execPath,
} as const;

export function profile(overrides: Partial<AcpSessionProfile> = {}): AcpSessionProfile {
  return {
    args: [fixture, "session"],
    capabilities: { queue: { durable: false }, attribution: "nested" },
    selectAuthMethod: () => "cached",
    abortTimeoutMs: 500,
    configureSession: async ({ request, sessionId }) => {
      await request(
        "session/set_mode",
        { sessionId, modeId: "yolo" },
      );
    },
    ...overrides,
  };
}

// oxlint-disable-next-line eslint/max-params -- the SessionOptions the ACP tests vary, positionally.
export async function start(
  overrides: Partial<AcpSessionProfile> = {},
  resume?: string,
  model?: string,
  effort?: string,
): Promise<Session> {
  return acpSession(profile(overrides))(installation, {
    cwd: process.cwd(),
    ...(resume === undefined ? {} : { resume }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  });
}

/** Compact skeleton of one record for assertions: kind, type/body kind, events. */
export function describe(record: RawEvent): string {
  switch (record.kind) {
    case "request":
      return `${record.direction === "toApp" ? "toApp" : "request"} ${record.body.kind === "native" ? record.body.type : record.body.kind}`;
    case "response":
      return `response ${record.body.kind}`;
    case "frame": {
      const events = record.body.events.map((view) => {
        switch (view.kind) {
          case "text_delta":
            return `text:${view.text}`;
          case "turn_ended":
            return `turn_ended:${view.outcome.kind}`;
          case "tool_call_started":
            return `tool_call_started:${view.tool}`;
          case "model":
            return `model:${view.model}`;
          case "effort":
            return `effort:${view.effort}`;
          case "reasoning":
          case "turn_active":
          case "tool_call_ended":
          case "service_tier":
          case "app_request_cancelled":
          case "input_dropped":
          case "user_message":
          case "usage":
          case "tool_call_progress":
          case "tool_call_input":
          case "tool_call_input_delta":
          case "compaction_started":
          case "compaction_ended":
          case "retry":
          case "task_started":
          case "task_updated":
          case "task_ended":
            return view.kind;
          default:
            return "?";
        }
      });
      return `event ${record.body.type}${events.length === 0 ? "" : ` → ${events.join(", ")}`}`;
    }
    default:
      return "?";
  }
}

/** Records after `afterSeq`, compacted. */
export function tail(session: Session, afterSeq: number): string[] {
  return session.records().filter((record) => record.seq > afterSeq).map((record) => describe(record));
}
