// BYOK change: Modified from OAR 95c6547 so the retention limit bounds the native payload of requests and replies too (Apache-2.0).
import type { Frame, RawEvent, RuntimeEventBody } from "../contracts/records.js";
import { UnsupportedOptionError } from "../contracts/errors.js";

function withoutPayload(event: RuntimeEventBody): RuntimeEventBody {
  if (event.kind === "tool_call_started") {
    const { input: _input, ...rest } = event;
    return rest;
  }
  if (event.kind === "tool_call_progress") {
    const { output: _output, outputDelta: _outputDelta, ...rest } = event;
    return rest;
  }
  if (event.kind === "tool_call_ended") {
    const { content: _content, ...rest } = event;
    return rest;
  }
  if (event.kind === "tool_call_input") { return { ...event, input: "" }; }
  return event.kind === "tool_call_input_delta" ? { ...event, delta: "" } : event;
}

const encoder = new TextEncoder();

/** UTF-8 bytes of the frame's `native` and of the tool events that elision changes. */
function payloadBytes(frame: Frame): number {
  const tools = frame.body.events.filter((event) => event !== withoutPayload(event));
  return encoder.encode(JSON.stringify(frame.body.native ?? null)).length + (tools.length === 0 ? 0 : encoder.encode(JSON.stringify(tools)).length);
}

function elided(frame: Frame): Frame {
  return { ...frame, body: { ...frame.body, native: null, events: frame.body.events.map((event) => withoutPayload(event)), elided: true } };
}

// BYOK change: a runtime request or a reply carries a native payload too (an ACP
// terminal/output reply, a Claude hook_callback); the limit bounds it like a frame's.
type NativeRecord = Extract<RawEvent, { kind: "request" | "response" }>;
function nativeOf(record: RawEvent | undefined): record is NativeRecord {
  return (record?.kind === "request" || record?.kind === "response") && "native" in record.body && record.body.native != null;
}
function nativeBytes(record: RawEvent): number {
  return record.kind === "frame" ? payloadBytes(record) : encoder.encode(JSON.stringify((record.body as { native: unknown }).native)).length;
}
function elidedRecord(record: RawEvent): RawEvent {
  return record.kind === "frame" ? elided(record) : { ...record, body: { ...record.body, native: null, elided: true } } as RawEvent;
}

export function checkRetainedBytes(retainedBytes: number | undefined): void {
  if (retainedBytes !== undefined && (!Number.isSafeInteger(retainedBytes) || retainedBytes <= 0)) {
    throw new UnsupportedOptionError("retainedBytes", `retainedBytes must be a positive integer, got ${String(retainedBytes)}`);
  }
}

/**
 * SessionOptions.retainedBytes: keeps the payloads of the newest frames within
 * the limit and elides older ones in place. It runs only after observers have
 * the records, so live delivery stays complete, and it keeps every record, so
 * `seq` stays dense and folds over kinds, usage and text are unchanged.
 */
export function recordRetention(limit: number): (log: RawEvent[], appended: number) => void {
  // Measured records not yet elided, by log index; a Map keeps insertion (index) order.
  const sizes = new Map<number, number>();
  let held = 0;
  let measured = 0;
  let newestFrame = -1;
  return (log, appended) => {
    for (; measured < appended; measured += 1) {
      const record = log[measured];
      if (record?.kind === "frame") { newestFrame = measured; }
      if (record !== undefined && (record.kind === "frame" || nativeOf(record))) {
        const size = nativeBytes(record);
        sizes.set(measured, size);
        held += size;
      }
    }
    // BYOK change: every measured record is a candidate, oldest first, except the
    // newest frame itself, so requests and replies after it, or in a log with no
    // frame, are elided too.
    for (const [index, size] of sizes) {
      if (held <= limit) { break; }
      const record = log[index];
      if (index === newestFrame || record === undefined) { continue; }
      log[index] = elidedRecord(record);
      held -= size;
      sizes.delete(index);
    }
  };
}
