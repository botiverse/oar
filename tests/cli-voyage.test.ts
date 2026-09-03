import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  endLine,
  eventLine,
  headerLine,
  openVoyage,
  submissionLine,
  type SessionEvent,
} from "../packages/oar/src/index.js";

afterEach(() => {
  vi.useRealTimers();
});

const event: SessionEvent = {
  sessionId: "s-1",
  turnId: "t-1",
  seq: 3,
  receivedAt: 1100,
  kind: "text_delta",
  text: "hello",
};

test("headerLine pins the oar-voyage/1 header shape", () => {
  expect(headerLine({
    runtime: "claude",
    model: "opus",
    cwd: "/work",
    sessionId: "s-1",
    startedAt: 1000,
    recorder: "oar-cli/0.0.5",
  })).toMatchInlineSnapshot(`"{"kind":"header","format":"oar-voyage/1","runtime":"claude","model":"opus","cwd":"/work","sessionId":"s-1","startedAt":1000,"recorder":"oar-cli/0.0.5"}"`);
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

test("submissionLine and endLine pin their shapes", () => {
  expect(submissionLine(1000, "prompt", "do the thing")).toMatchInlineSnapshot(
    `"{"kind":"submission","at":1000,"via":"prompt","text":"do the thing"}"`,
  );
  expect(endLine(2000, "disposed")).toMatchInlineSnapshot(
    `"{"kind":"end","at":2000,"reason":"disposed"}"`,
  );
});

test("eventLine wraps the raw SessionEvent verbatim", () => {
  const parsed: unknown = JSON.parse(eventLine(event));
  assert.deepEqual(parsed, { kind: "event", event });
});

function recordSampleVoyage(path: string): string[] {
  const recorder = openVoyage(path, {
    runtime: "claude",
    cwd: "/work",
    sessionId: "s-1",
    startedAt: 5000,
    recorder: "oar-cli/0.0.5",
  });
  recorder.submission("prompt", "hi");
  recorder.event(event);
  vi.setSystemTime(9000);
  recorder.end("disposed");
  return readFileSync(path, "utf8").split("\n");
}

test("openVoyage writes header, submission, event, end as ordered JSONL", () => {
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
      submissionLine(5000, "prompt", "hi"),
      eventLine(event),
      endLine(9000, "disposed"),
      "",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
