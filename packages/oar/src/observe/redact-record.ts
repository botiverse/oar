import type { RawEvent } from "../contracts/records.js";
import { redactGrokNotification } from "../shared/credential-redaction.js";
import { asRecord } from "../shared/json.js";

/**
 * A stored record with oar's current credential-redaction rules applied
 * (docs/spec/record-stream.md), for records a host kept before a rule
 * existed: grok's `_x.ai/mcp/*` notifications recorded by oar before 0.32.1
 * carry the user's own MCP server `env` values in plain text. Only a frame's
 * `native` can change, as the live adapter would now have recorded it.
 *
 * Pure and idempotent: a record no rule touches, or one already redacted,
 * comes back as the same object, so a host can run it over all of its
 * storage on every start and rewrite only the records it returns changed.
 */
export function redactRecord(record: RawEvent): RawEvent {
  if (record.kind !== "frame") {
    return record;
  }
  const native = asRecord(record.body.native);
  if (native === null) {
    return record;
  }
  const redacted = redactGrokNotification(record.body.type, native);
  if (redacted === native || JSON.stringify(redacted) === JSON.stringify(native)) {
    return record;
  }
  return { ...record, body: { ...record.body, native: redacted } };
}
