import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";

/** A passing suite without any process evidence is an observation failure. */
export function verifyCapture(directory: string): number {
  const files = readdirSync(directory).filter(file => file.endsWith(".jsonl"));
  assert.ok(files.length > 0, `No Grok process traces in ${directory}`);
  let initialized = false;
  for (const file of files) {
    const rows = readFileSync(path.join(directory, file), "utf8").trim().split("\n").map(line => {
      const row = asRecord(parseJson(line)); assert.ok(row, `Invalid trace row in ${file}`); return row;
    });
    assert.ok(rows.some(row => row.phase === "spawn_requested"), `Missing spawn in ${file}`);
    if (rows.some(row => row.phase === "request_sent" && row.method === "initialize")) { initialized = true; }
  }
  assert.ok(initialized, `No ACP initialize request observed in ${directory}`);
  return files.length;
}
