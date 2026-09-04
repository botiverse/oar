/**
 * CLAUDE MODEL LIST — pins the stream-json `list_models` control request.
 *
 * Claude exposes model listing on the control channel of the stream-json
 * transport, not as a CLI subcommand: send
 * `{"type":"control_request","request_id":"...","request":{"subtype":"list_models"}}`
 * and a `control_response` comes back before any turn runs. Zero tokens.
 *
 * Run: pnpm tsx experiments/claude-list-models.ts
 * Exits non-zero on any unmet expectation. No tokens consumed.
 *
 * ── OBSERVED 2026-09-04, claude 2.1.237, linux x64 ──
 *
 * `--verbose` is REQUIRED with `--output-format stream-json` in print mode;
 * without it the CLI errors before the control channel opens.
 *
 * The success response carries `models[]` with per-model: `value` (the
 * SELECTOR — an alias like "default", "opus[1m]", "sonnet", "haiku", or a
 * full ID) vs `resolvedModel` (the CONCRETE ID the alias resolves to today) —
 * the alias-vs-resolution distinction a unified contract must keep;
 * `displayName`, `description`, `supportsEffort`, `supportedEffortLevels`
 * (["low","medium","high","xhigh","max"] where supported),
 * `supportsAdaptiveThinking`, `supportsFastMode`, `supportsAutoMode`,
 * `disabled`. Observed resolutions: default→claude-opus-5[1m],
 * opus[1m]→claude-opus-5[1m], sonnet→claude-sonnet-5,
 * haiku→claude-haiku-4-5-20251001. A disabled entry `cc-update-required-1`
 * ("Fable 5.1", "Update to 2.1.255+ to use Fable 5.1", disabled:true) shows
 * the list is login/plan/CLI-version-aware: what you get depends on account
 * state AND installed CLI version, i.e. usable-now semantics.
 *
 * Unknown subtypes fail with "Unsupported control request subtype: X" and the
 * error does NOT enumerate valid subtypes — no discovery channel.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function asRecordList(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: unknown[] = value;
  const records: Record<string, unknown>[] = [];
  for (const entry of entries) {
    const record = asRecord(entry);
    if (record !== null) {
      records.push(record);
    }
  }
  return records;
}

const child = spawn("claude", [
  "-p",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
], { stdio: ["pipe", "pipe", "inherit"] });

const requestId = "list-models-probe";
child.stdin.write(`${JSON.stringify({
  type: "control_request",
  request_id: requestId,
  request: { subtype: "list_models" },
})}\n`);

// Timeout by killing the child: stdout then ends and the line loop exits
// with `response` still null, which the assert below reports.
const killTimer = setTimeout(() => {
  child.kill();
}, 60_000);
let response: Record<string, unknown> | null = null;
for await (const line of createInterface({ input: child.stdout })) {
  const message = ((): unknown => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })();
  const record = asRecord(message);
  if (record !== null && record.type === "control_response") {
    response = record;
    break;
  }
}
clearTimeout(killTimer);
child.kill();
assert.ok(response !== null, "no control_response within 60s");

const inner = asRecord(response.response);
assert.ok(inner !== null, "control_response without response body");
assert.equal(inner.subtype, "success", `control_response not success: ${JSON.stringify(inner)}`);
assert.equal(inner.request_id, requestId);
const payload = asRecord(inner.response);
assert.ok(payload !== null, "success response without payload");
const models = asRecordList(payload.models);
assert.ok(models.length > 0, "models[] empty");
for (const model of models) {
  assert.equal(typeof model.value, "string", "model without value selector");
}

process.stdout.write(`${JSON.stringify({
  totalModels: models.length,
  selectors: models.map((model) => ({
    value: model.value,
    resolvedModel: model.resolvedModel ?? null,
    disabled: model.disabled === true,
    effortLevels: model.supportedEffortLevels ?? null,
  })),
}, null, 2)}\n`);
