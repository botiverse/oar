/** Check a real ACP probe's projected inputs against the same frames' native rawInput. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { asRecord, asRecordList, parseJson } from "../../packages/oar/src/shared/json.js";

const file = process.argv.at(2);
assert.ok(file !== undefined && file.length > 0, "Pass the JSON produced by probe.ts");
const data = asRecord(parseJson(await readFile(file, "utf8")));
assert.equal(data?.failure, null);
const projected: { tool: string; bytes: number }[] = [];
const tools = new Map<string, string>();
for (const record of asRecordList(data.records)) {
  const body = asRecord(record.body);
  const update = asRecord(asRecord(body?.native)?.update);
  for (const event of asRecordList(body?.events)) {
    if (event.kind === "tool_call_started") { tools.set(String(event.callId), String(event.tool)); }
    if (event.kind === "tool_call_started" || event.kind === "tool_call_input") {
      const native = update?.rawInput;
      const expected = typeof native === "string" ? native : JSON.stringify(native ?? undefined);
      assert.equal(event.input, expected, `${String(data.runtimeId)} ${String(event.callId)}`);
      if (typeof event.input === "string") {
        projected.push({ tool: tools.get(String(event.callId)) ?? "unknown", bytes: Buffer.byteLength(event.input) });
      }
    }
  }
}
assert.ok(projected.length > 0);
console.log(JSON.stringify({ runtime: data.runtimeId, inputs: projected }, null, 2));
