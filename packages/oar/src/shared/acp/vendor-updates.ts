import type { AnyMessage, SessionNotification } from "@agentclientprotocol/sdk";
import { asRecord, type JsonRecord } from "../json.js";

/**
 * Vendor `session/update` kinds the SDK would drop. SDK 1.4.0 parses every
 * `session/update` against a closed union of standard kinds and swallows the
 * frame when the parse fails ("Error handling notification"), so cursor-agent
 * 2026.09.28's `subagent_spawned` / `subagent_state_update` never reach a
 * handler. The frame is carried through as a standard `session_info_update`
 * whose `_meta` (an open record the SDK keeps as is) holds the original
 * update, and the recorder restores it. Renaming the method instead would
 * move the frame to another handler chain, which the SDK dispatches without
 * ordering against `session/update`; this way it stays in wire order.
 */
const carrierKey = "oar/vendorSessionUpdate";

function disguise(message: unknown, kinds: ReadonlySet<string>): unknown {
  if (Array.isArray(message)) {
    return message.map((item: unknown) => disguise(item, kinds));
  }
  const frame = asRecord(message);
  const params = asRecord(frame?.params);
  const update = asRecord(params?.update);
  const kind = update?.sessionUpdate;
  if (frame === null || frame.method !== "session/update" || params === null || typeof kind !== "string" || !kinds.has(kind)) {
    return message;
  }
  return { ...frame, params: { ...params, update: { sessionUpdate: "session_info_update", _meta: { [carrierKey]: update } } } };
}

/** A stream transform that carries the listed vendor update kinds past the SDK's parse. */
export function vendorSessionUpdateCarrier(kinds: readonly string[]): TransformStream<AnyMessage, AnyMessage> {
  const listed = new Set(kinds);
  return new TransformStream<AnyMessage, AnyMessage>({
    transform(message, controller) {
      // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion -- Only the update payload changes; the JSON-RPC envelope keeps its shape.
      controller.enqueue(listed.size === 0 ? message : disguise(message, listed) as AnyMessage);
    },
  });
}

/** The vendor update a carried frame holds, or null for a standard one. */
export function carriedVendorUpdate(notification: SessionNotification): JsonRecord | null {
  const update = asRecord(notification.update);
  if (update?.sessionUpdate !== "session_info_update") {
    return null;
  }
  // oxlint-disable-next-line eslint/no-underscore-dangle -- `_meta` is the ACP extension envelope.
  return asRecord(asRecord(update._meta)?.[carrierKey]);
}
