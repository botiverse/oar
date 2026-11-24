/* oxlint-disable import/prefer-default-export -- fixtures export names, like the package. */
import type { Frame, InputOptions, RequestRecord, ResponseRecord, RuntimeEventBody } from "../../packages/oar/src/contracts/session.js";

/**
 * Record builders for queue-snapshot cases (docs/spec/queue-snapshot.md):
 * the requests, answers and native events a host's persisted log holds. The
 * shapes are the contracts', so a case reads like the stream it stands for.
 */

export const SNAPSHOT_INPUT = "11111111-2222-4333-8444-555555555555";
export const OTHER_INPUT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
export const SECOND_INPUT = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
export const THIRD_INPUT = "cccccccc-dddd-4eee-8fff-000000000000";
export const SESSION = "native";
export const STREAM = "stream-1";

type InputBody = { readonly inputId?: string; readonly input: string } & InputOptions;
interface InputAction { readonly kind: "prompt" | "steer" | "queue" }
const envelope = (seq: number, agentPath: readonly string[] = []): { sessionId: string; agentPath: readonly string[]; seq: number; receivedAt: number } =>
  ({ sessionId: SESSION, agentPath, seq, receivedAt: 1 });

export function request(seq: number, id: string, body: InputBody & InputAction): RequestRecord {
  return { ...envelope(seq), kind: "request", id, direction: "toRuntime", body };
}
export function queue(seq: number, id: string, options: Partial<InputBody> = {}): RequestRecord {
  return request(seq, id, { kind: "queue", input: "later", inputId: SNAPSHOT_INPUT, ...options });
}
export function prompt(seq: number, id: string, options: Partial<InputBody> & { readonly carries?: readonly string[] } = {}): RequestRecord {
  return request(seq, id, { kind: "prompt", input: "now", inputId: OTHER_INPUT, ...options });
}
export function steer(seq: number, id: string, options: Partial<InputBody> = {}): RequestRecord {
  return request(seq, id, { kind: "steer", input: "mid", inputId: SNAPSHOT_INPUT, ...options });
}
export function withdraw(seq: number, id: string, target = SNAPSHOT_INPUT): RequestRecord {
  return { ...envelope(seq), kind: "request", id, direction: "toRuntime", body: { kind: "withdraw", inputId: target } };
}
export function accepted(seq: number, requestId: string, queued?: "adapter"): ResponseRecord {
  return { ...envelope(seq), kind: "response", requestId, body: { kind: "accepted", ...(queued === undefined ? {} : { queued }) } };
}
export function rejected(seq: number, requestId: string, code: "not_queued" | "unsupported" | "busy" = "unsupported"): ResponseRecord {
  return { ...envelope(seq), kind: "response", requestId, body: { kind: "rejected", code, reason: "refused" } };
}
export function exited(seq: number): ResponseRecord {
  return { ...envelope(seq), kind: "response", requestId: "", body: { kind: "exited", code: 0 } };
}
type NativeInput = Extract<RuntimeEventBody, { readonly kind: "user_message" | "input_queued" | "input_dropped" | "input_handled" }>;
export function frame(seq: number, events: NativeInput[]): Frame {
  return { ...envelope(seq), kind: "frame", body: { type: "test", native: {}, events } };
}
export function echo(seq: number, inputId = OTHER_INPUT): Frame {
  return frame(seq, [{ kind: "user_message", input: "now", inputId, evidence: "turn_item" }]);
}
/** An input queued in a child agent lane, to prove lanes never alias. */
export function childQueue(seq: number, id: string, input = "child work"): RequestRecord {
  return { ...queue(seq, id, { input }), agentPath: ["researcher"] };
}
/** One lane's copy of a request or its answer: the fold links a response to its request by lane, so a lane case moves the whole set. */
export function inLane(record: RequestRecord | ResponseRecord, agentPath: readonly string[]): RequestRecord | ResponseRecord {
  return { ...record, agentPath };
}
