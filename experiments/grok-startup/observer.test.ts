/* oxlint-disable import/max-dependencies -- Standalone cross-platform experiment validation. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";

const fixture = fileURLToPath(new URL("observer-fixture.ts", import.meta.url));
function run(scenario: string, observe = true, failedLog = false): { code: number | null; stdout: string; stderr: string; rows: Record<string, unknown>[]; evidence: string; bytes: number } {
  const directory = mkdtempSync(path.join(tmpdir(), "grok-observer-test-"));
  const trace = path.join(directory, "trace");
  if (failedLog) { writeFileSync(trace, "not a directory"); }
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", fixture], {
      encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, SCENARIO: scenario, OBSERVE: observe ? "1" : "0", GROK_HOME: directory, OAR_GROK_PROCESS_TRACE: trace, TEST_API_KEY: "synthetic-env-secret-123456789" },
    });
    assert.equal(result.error, undefined);
    const names = observe && !failedLog ? readdirSync(trace) : [];
    const texts = names.map(name => readFileSync(path.join(trace, name), "utf8"));
    const evidence = texts.join("\n");
    assert.ok(!evidence.includes(directory));
    const rows = names.flatMap((name, index) => name.endsWith(".jsonl") ? (texts[index] ?? "").trim().split("\n").map(line => {
      const record = asRecord(parseJson(line)); assert.ok(record); return record;
    }) : []);
    return { code: result.status, stdout: result.stdout, stderr: result.stderr, rows, evidence, bytes: Buffer.byteLength(evidence) };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("observation preserves native bytes, write callbacks and return values", () => {
  const control = run("success", false);
  const result = run("success");
  assert.equal(result.stdout, control.stdout);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(result.rows.filter(row => row.phase === "request_sent").map(row => row.method), ["initialize", "authenticate", "session/new", "session/prompt"]);
  assert.deepEqual(result.rows.filter(row => row.phase === "response_received").map(row => row.method), ["initialize", "authenticate", "session/new", "session/prompt"]);
  for (const phase of ["spawn_requested", "spawned", "first_stdout", "first_protocol_frame", "first_session_update", "first_agent_output", "exit", "close"]) { assert.ok(result.rows.some(row => row.phase === phase), phase); }
  for (const secret of ["synthetic-auth-secret", "synthetic-mcp-secret", "private-prompt-text", "private-result", "private-output"]) { assert.ok(!result.evidence.includes(secret), secret); }
});

for (const stage of ["initialize", "authenticate", "session/new", "session/prompt"]) {
  test(`retains the unanswered ${stage} and forced exit of that same process`, () => {
    const result = run(stage);
    assert.equal(result.code, 0);
    assert.equal(result.rows.findLast(row => row.phase === "request_sent")?.method, stage);
    assert.ok(!result.rows.some(row => row.phase === "response_received" && row.method === stage));
    const closed = result.rows.find(row => row.phase === "close");
    assert.ok(closed);
    assert.notEqual(closed.exitCode === null && closed.exitSignal === null, true);
    assert.ok(result.evidence.includes("fixture-stalled"));
  });
}

test("retains nonzero exit, unterminated stderr tail and split-credential redaction", () => {
  const result = run("exit");
  assert.equal(result.rows.find(row => row.phase === "exit")?.exitCode, 23);
  assert.ok(result.evidence.includes("last diagnostic without newline"));
  assert.ok(result.evidence.includes("[redacted]"));
  assert.ok(!result.evidence.includes("synthetic-auth-secret"));
});

test("bounded traces still retain exit and leave oversized native output intact", () => {
  const control = run("flood", false);
  const result = run("flood");
  assert.equal(result.stdout, control.stdout);
  assert.ok(result.rows.some(row => row.phase === "trace_truncated"));
  assert.ok(result.rows.some(row => row.phase === "close"));
  assert.ok(result.bytes < 80 * 1024);
});

test("unhandled spawn errors remain unhandled", () => {
  const result = run("spawn-error");
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes("ENOENT"));
  assert.ok(result.rows.some(row => row.phase === "process_error"));
});

test("diagnostic filesystem failure does not fail or retry the original child", () => {
  const control = run("success", false);
  const result = run("success", true, true);
  assert.equal(result.stdout, control.stdout);
  assert.equal(result.code, control.code);
  assert.equal(result.stderr.trim(), "[grok observation] diagnostic write failed");
});


test("protocol line bound counts UTF-8 bytes and preserves the next frame", () => {
  const control = run("multibyte-line", false);
  const result = run("multibyte-line");
  assert.equal(result.stdout, control.stdout);
  assert.ok(result.rows.some(row => row.phase === "output_line_omitted"));
  assert.ok(result.rows.some(row => row.phase === "response_received" && row.method === "initialize"));
});


test("backpressure and callbacks remain native", () => {
  const control = run("backpressure", false);
  const result = run("backpressure");
  assert.equal(result.stdout, control.stdout);
  const output = asRecord(parseJson(result.stdout));
  assert.equal(output?.writes, 8);
  assert.ok(Array.isArray(output.returns) && output.returns.includes(false));
});
