/**
 * CODEX MODEL LIST — pins `codex debug models` as the usable-models surface.
 *
 * The question for a unified listModels is not "what models exist in a static
 * catalog" but "what can this account use right now". Codex answers that:
 * `codex debug models` fetches the list live from the *active configured
 * provider* (here a custom `cortex` proxy via base_url + wire_api
 * "responses"), so the result is scoped to the current provider config and
 * login state, then cached to ~/.codex/models_cache.json
 * `{client_version, fetched_at, models}`.
 *
 * Run: pnpm tsx experiments/codex-list-models.ts
 * Exits non-zero on any unmet expectation. No tokens consumed.
 *
 * ── OBSERVED 2026-09-04, codex 0.149.0, linux x64 ──
 *
 * Stdout is pure JSON: `{"models":[...]}` — 43 entries, ~1.8MB, because each
 * model embeds its full instruction templates. Consumers MUST project fields;
 * shipping the raw payload downstream is not viable.
 *
 * Per-model fields: `slug` (stable identity), `display_name` (UNRELIABLE as
 * identity — claude-fable-5 renders as "GPT 5.6 Sol"), `description`,
 * `default_reasoning_level`, `supported_reasoning_levels`
 * (low/medium/high/xhigh/max/ultra), `shell_type`, `visibility`
 * ("list" | "hide" — hidden entries are present in the payload),
 * `supported_in_api`, `priority`, `service_tiers`, `availability_nux`,
 * `upgrade`. So: identity = slug, display_name is presentation only, and the
 * payload carries its own visibility + effort-level enumeration.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

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

const stdout = execFileSync("codex", ["debug", "models"], {
  maxBuffer: 64 * 1024 * 1024,
  encoding: "utf8",
});

const parsed: unknown = JSON.parse(stdout);
const top = asRecord(parsed);
assert.ok(top !== null, "stdout was not a JSON object");
const models = asRecordList(top.models);
assert.ok(models.length > 0, "models[] empty");

for (const model of models) {
  assert.equal(typeof model.slug, "string", "model without slug");
  assert.ok(
    Array.isArray(model.supported_reasoning_levels),
    `${String(model.slug)}: no supported_reasoning_levels`,
  );
  assert.ok(
    model.visibility === "list" || model.visibility === "hide",
    `${String(model.slug)}: unexpected visibility ${String(model.visibility)}`,
  );
}

const listed = models.filter((model) => model.visibility === "list");
process.stdout.write(`${JSON.stringify({
  totalModels: models.length,
  listedModels: listed.length,
  payloadBytes: stdout.length,
  sampleSlugs: models.slice(0, 5).map((model) => model.slug),
}, null, 2)}\n`);
