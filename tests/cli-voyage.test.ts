import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  endLine,
  headerLine,
  openVoyage,
  recordLine,
  type SessionRecord,
} from "../packages/oar/src/index.js";

afterEach(() => {
  vi.useRealTimers();
});

const request: SessionRecord = {
  sessionId: "s-1",
  agentPath: [],
  seq: 2,
  receivedAt: 1050,
  kind: "request",
  id: "rq-1",
  direction: "toRuntime",
  body: { kind: "prompt", input: "hi" },
};

const event: SessionRecord = {
  sessionId: "s-1",
  agentPath: ["a1"],
  seq: 3,
  receivedAt: 1100,
  kind: "event",
  body: { type: "assistant", native: { type: "assistant" }, views: [{ kind: "text_delta", text: "hello" }] },
};

test("headerLine pins the oar-voyage/2 header shape", () => {
  expect(headerLine({
    runtime: "claude",
    model: "opus",
    cwd: "/work",
    sessionId: "s-1",
    startedAt: 1000,
    recorder: "oar-cli/0.0.5",
  })).toMatchInlineSnapshot(`"{"kind":"header","format":"oar-voyage/2","runtime":"claude","model":"opus","cwd":"/work","sessionId":"s-1","startedAt":1000,"recorder":"oar-cli/0.0.5"}"`);
});

test("headerLine omits model entirely when none was requested", () => {
  const line = headerLine({
    runtime: "codex",
    cwd: "/work",
    sessionId: "s-2",
    startedAt: 1000,
    recorder: "oar-cli/0.0.5",
  });
  assert.ok(!line.includes("model"), `model key must be absent: ${line}`);
});

test("endLine pins its shape", () => {
  expect(endLine(2000, "disposed")).toMatchInlineSnapshot(
    `"{"kind":"end","at":2000,"reason":"disposed"}"`,
  );
});

test("recordLine wraps the SessionRecord verbatim, requests included", () => {
  assert.deepEqual(JSON.parse(recordLine(event)), { kind: "record", record: event });
  assert.deepEqual(JSON.parse(recordLine(request)), { kind: "record", record: request });
});

function recordSampleVoyage(path: string): string[] {
  const recorder = openVoyage(path, {
    runtime: "claude",
    cwd: "/work",
    sessionId: "s-1",
    startedAt: 5000,
    recorder: "oar-cli/0.0.5",
  });
  recorder.record(request);
  recorder.record(event);
  vi.setSystemTime(9000);
  recorder.end("disposed");
  return readFileSync(path, "utf8").split("\n");
}

test("openVoyage writes header, records, end as ordered JSONL", () => {
  vi.useFakeTimers();
  vi.setSystemTime(5000);
  const dir = mkdtempSync(join(tmpdir(), "oar-voyage-"));
  const path = join(dir, "run.jsonl");
  try {
    const lines = recordSampleVoyage(path);
    assert.deepEqual(lines, [
      headerLine({
        runtime: "claude",
        cwd: "/work",
        sessionId: "s-1",
        startedAt: 5000,
        recorder: "oar-cli/0.0.5",
      }),
      recordLine(request),
      recordLine(event),
      endLine(9000, "disposed"),
      "",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
