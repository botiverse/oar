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
  const sizes = new Map<number, number>();
  let held = 0;
  let oldest = 0;
  let measured = 0;
  let newestFrame = -1;
  return (log, appended) => {
    for (; measured < appended; measured += 1) {
      const record = log[measured];
      if (record?.kind === "frame") {
        newestFrame = measured;
        const size = payloadBytes(record);
        sizes.set(measured, size);
        held += size;
      }
    }
    for (; held > limit && oldest < newestFrame; oldest += 1) {
      const record = log[oldest];
      if (record?.kind === "frame") {
        log[oldest] = elided(record);
        held -= sizes.get(oldest) ?? 0;
        sizes.delete(oldest);
      }
    }
  };
}
