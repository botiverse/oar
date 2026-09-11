import { fileURLToPath } from "node:url";
import type { Session, SessionRecord } from "../../packages/oar/src/contracts/session.js";
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
    capabilities: { steer: false, queue: { durable: false }, attribution: "nested" },
    selectAuthMethod: () => "cached",
    abortTimeoutMs: 500,
    configureSession: async ({ connection, sessionId, requestOptions }) => {
      await connection.agent.request(
        "session/set_mode",
        { sessionId, modeId: "yolo" },
        requestOptions,
      );
    },
    ...overrides,
  };
}

export async function start(
  overrides: Partial<AcpSessionProfile> = {},
  resume?: string,
  model?: string,
): Promise<Session> {
  return acpSession(profile(overrides))(installation, {
    cwd: process.cwd(),
    ...(resume === undefined ? {} : { resume }),
    ...(model === undefined ? {} : { model }),
  });
}

/** Compact skeleton of one record for assertions: kind, type/body kind, views. */
export function describe(record: SessionRecord): string {
  switch (record.kind) {
    case "request":
      return `${record.direction === "toApp" ? "toApp" : "request"} ${record.body.kind === "native" ? record.body.type : record.body.kind}`;
    case "response":
      return `response ${record.body.kind}`;
    case "event": {
      const views = record.body.views.map((view) => {
        switch (view.kind) {
          case "text_delta":
            return `text:${view.text}`;
          case "turn_ended":
            return `turn_ended:${view.outcome.kind}`;
          case "tool_call_started":
            return `tool_call_started:${view.tool}`;
          case "model":
            return `model:${view.model}`;
          case "reasoning":
          case "tool_call_ended":
          case "usage":
            return view.kind;
          default:
            return "?";
        }
      });
      return `event ${record.body.type}${views.length === 0 ? "" : ` → ${views.join(", ")}`}`;
    }
    default:
      return "?";
  }
}

/** Records after `afterSeq`, compacted. */
export function tail(session: Session, afterSeq: number): string[] {
  return session.records().filter((record) => record.seq > afterSeq).map((record) => describe(record));
}

