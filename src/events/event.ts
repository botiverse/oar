/**
 * Outbound events, as a discriminated union with exhaustive handling.
 *
 * A new event kind must break every consumer that ignores it -- at build time.
 * Silently dropping an unrecognised kind is a failure mode already paid for.
 *
 * Envelope, never payload: these carry protocol-observable facts (a tool call
 * named X occurred; it preceded its result; the turn closed). Model output is
 * stochastic, so nothing here asserts what the model said.
 */
export type RuntimeEvent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool_call"; readonly callId: string; readonly name: string }
  | { readonly kind: "tool_result"; readonly callId: string; readonly ok: boolean }
  | { readonly kind: "turn_end"; readonly reason: TurnEndReason }
  /**
   * The runtime failed in a way the consumer must see. `detail` is already
   * bounded and scrubbed -- see `diagnostic.ts`. There is deliberately no
   * variant carrying raw stderr: a consumer cannot be handed an unscrubbed
   * credential-bearing channel by accident, because no such variant exists.
   */
  | { readonly kind: "runtime_error"; readonly detail: import("./diagnostic.js").Diagnostic };

/**
 * Why a turn ended. `crashed` is distinct from `completed` because the
 * silent-failure signature we keep paying for -- alive but emitting nothing --
 * is only detectable if "ended without producing anything" is expressible.
 */
export type TurnEndReason = "completed" | "interrupted" | "crashed";

/**
 * Exhaustive by construction: adding a variant above makes this fail to
 * compile rather than fall through. The `never` binding is the tooth.
 */
export function describeEvent(event: RuntimeEvent): string {
  switch (event.kind) {
    case "text":
      return `text(${String(event.text.length)})`;
    case "tool_call":
      return `tool_call(${event.name})`;
    case "tool_result":
      return `tool_result(${event.callId},${event.ok ? "ok" : "err"})`;
    case "turn_end":
      return `turn_end(${event.reason})`;
    case "runtime_error":
      return `runtime_error(${event.detail.errorClass})`;
    default: {
      const unhandled: never = event;
      return String(unhandled);
    }
  }
}
