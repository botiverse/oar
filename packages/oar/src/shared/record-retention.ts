// BYOK change: Modified from OAR 95c6547 so the retention limit bounds the native payload of requests and replies too, and a second limit bounds text and reasoning (Apache-2.0).
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

// BYOK change: text and reasoning have their own limit, so a task with much
// text never elides earlier the native frames a failure scan reads (the Grok
// retry_state of the current turn).
/** Text and reasoning bytes a retaining session keeps besides its native and tool payloads. */
export const RETAINED_TEXT_BYTES = 16 * 1024 * 1024;

function withoutText(event: RuntimeEventBody): RuntimeEventBody {
  if (event.kind === "text_delta") { return event.text === "" ? event : { ...event, text: "" }; }
  return event.kind === "reasoning" && event.content.kind === "text" && event.content.text !== ""
    ? { ...event, content: { kind: "text", text: "" } }
    : event;
}

/** UTF-8 bytes of the frame's text_delta and readable reasoning text. */
function textBytes(record: RawEvent): number {
  if (record.kind !== "frame") { return 0; }
  let bytes = 0;
  for (const event of record.body.events) {
    if (event.kind === "text_delta") { bytes += encoder.encode(event.text).length; }
    if (event.kind === "reasoning" && event.content.kind === "text") { bytes += encoder.encode(event.content.text).length; }
  }
  return bytes;
}

function textElided(record: RawEvent): RawEvent {
  return record.kind === "frame" ? { ...record, body: { ...record.body, events: record.body.events.map((event) => withoutText(event)), elided: true } } : record;
}

/** Records measured against one limit and not yet elided, by log index; a Map keeps insertion (index) order. */
interface Ledger {
  readonly limit: number;
  readonly sizes: Map<number, number>;
  held: number;
}

function hold(ledger: Ledger, index: number, size: number): void {
  if (size === 0) { return; }
  ledger.sizes.set(index, size);
  ledger.held += size;
}

// BYOK change: every measured record is a candidate, oldest first, except the
// newest frame itself, so requests and replies after it, or in a log with no
// frame, are elided too.
function trim(log: RawEvent[], ledger: Ledger, newestFrame: number, elide: (record: RawEvent) => RawEvent): void {
  for (const [index, size] of ledger.sizes) {
    if (ledger.held <= ledger.limit) { break; }
    const record = log[index];
    if (index === newestFrame || record === undefined) { continue; }
    log[index] = elide(record);
    ledger.held -= size;
    ledger.sizes.delete(index);
  }
}

/**
 * SessionOptions.retainedBytes: keeps the payloads of the newest frames within
 * the limit and elides older ones in place; text and reasoning are kept within
 * `textLimit` the same way, as a separate budget. It runs only after observers
 * have the records, so live delivery stays complete, and it keeps every record,
 * so `seq` stays dense and folds over kinds and usage are unchanged.
 */
export function recordRetention(limit: number, textLimit: number = RETAINED_TEXT_BYTES): (log: RawEvent[], appended: number) => void {
  const payload: Ledger = { limit, sizes: new Map(), held: 0 };
  const text: Ledger = { limit: textLimit, sizes: new Map(), held: 0 };
  let measured = 0;
  let newestFrame = -1;
  return (log, appended) => {
    for (; measured < appended; measured += 1) {
      const record = log[measured];
      if (record === undefined) { continue; }
      if (record.kind === "frame") { newestFrame = measured; }
      if (record.kind === "frame" || nativeOf(record)) { hold(payload, measured, nativeBytes(record)); }
      hold(text, measured, textBytes(record));
    }
    trim(log, payload, newestFrame, elidedRecord);
    trim(log, text, newestFrame, textElided);
  };
}
