import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";

const [stopFile] = process.argv.slice(2);
assert.ok(stopFile !== undefined);
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
createInterface({ input: process.stdin }).on("line", (line) => {
  const frame: unknown = JSON.parse(line);
  assert.ok(record(frame) && record(frame.request));
  const initialize = frame.request.type === "daemon.initialize";
  console.log(JSON.stringify({ type: "control_response", ...(initialize ? {} : { session_id: "eof-session" }),
    response: { request_id: frame.request_id, subtype: "success", response: initialize
      ? { daemon_protocol_version: 2, capabilities: ["multi_session_v2", "daemon_queries_v1"] } : {} } }));
});
process.stdin.on("end", () => {
  console.log("eof");
  // The parent releases this fixture only after the fallback's table read has
  // started, so native exit is deterministically inside that read on every OS.
  setInterval(() => { if (existsSync(stopFile)) { process.exit(0); } }, 10);
});
console.log("ready");
