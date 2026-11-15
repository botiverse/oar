import assert from "node:assert/strict";
import { asRecord } from "../../packages/oar/src/shared/json.js";

/** PIDs remain useful diagnostics, but may recur after an earlier fixture exits. */
export default function acpFixtureMethodsByInstance(contents: string): Map<string, string[]> {
  const processes = new Map<string, string[]>();
  for (const line of contents.trim().split("\n")) {
    const row = asRecord(JSON.parse(line));
    assert.ok(typeof row?.instanceId === "string" && row.instanceId.length > 0, `Missing fixture instance identity: ${line}`);
    assert.ok(typeof row.method === "string", `Missing fixture method: ${line}`);
    const methods = processes.get(row.instanceId) ?? [];
    methods.push(row.method);
    processes.set(row.instanceId, methods);
  }
  return processes;
}
