import type { Event, RuntimeEventBody } from "../contracts/session.js";
import type { ToolOutputPart } from "../contracts/tool-output.js";
import { asRecord } from "../shared/json.js";
import { toolContent } from "../shared/tool-output.js";

/**
 * Records written by an older OAR, read through today's folds. Hosts persist
 * records and replay them (foundations: the host owns its data layer), so a
 * fold must still read what an earlier version wrote. Each upgrade names the
 * version whose shape it reads; nothing here changes a current record.
 */

function isContentBlockArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value) && value.length > 0 && value.every((block) => typeof asRecord(block)?.type === "string");
}

/**
 * Before 0.14.0, `tool_call_ended` carried the result as one `output` string.
 * As `content`: the JSON of content blocks (claude stringified its
 * `tool_result` blocks) becomes their parts, a JSON string literal (claude
 * quoted a plain string result) becomes its text, and anything else is the
 * text it was.
 */
export function contentOfLegacyOutput(output: string): readonly ToolOutputPart[] {
  let parsed: unknown = undefined;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [{ type: "text", text: output }];
  }
  if (isContentBlockArray(parsed)) {
    return toolContent(parsed) ?? [{ type: "text", text: output }];
  }
  return [{ type: "text", text: typeof parsed === "string" ? parsed : output }];
}

/** A pre-0.14.0 tool end's `output`, when the event is one; undefined otherwise. */
function legacyOutput(event: RuntimeEventBody): string | undefined {
  if (event.kind !== "tool_call_ended" || event.content !== undefined) {
    return undefined;
  }
  const output = asRecord(event)?.output;
  return typeof output === "string" ? output : undefined;
}

/** An event body as today's folds read it: a pre-0.14.0 tool end gets `content` from its `output`. */
export function upgradeLegacyBody(event: RuntimeEventBody): RuntimeEventBody {
  const output = legacyOutput(event);
  if (output === undefined || event.kind !== "tool_call_ended") {
    return event;
  }
  const { callId, result, exitCode } = event;
  return {
    kind: "tool_call_ended",
    callId,
    content: contentOfLegacyOutput(output),
    ...(result === undefined ? {} : { result }),
    ...(exitCode === undefined ? {} : { exitCode }),
  };
}

/** The same for a flattened `Event` (`session.events()` logs written before 0.14.0). */
export function upgradeLegacyEvent(event: Event): Event {
  if (event.kind !== "tool_call_ended") {
    return event;
  }
  const output = legacyOutput(event);
  return output === undefined ? event : { ...event, content: contentOfLegacyOutput(output) };
}
