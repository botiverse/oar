/**
 * GROK MODEL LIST — pins the `x.ai/models/list` ACP extension method.
 *
 * Run:
 *   OAR_GROK_BIN=/path/to/grok pnpm tsx experiments/grok-list-models.ts
 * Exits non-zero on any unmet expectation. No tokens consumed.
 *
 * ── OBSERVED 2026-09-04 FROM SOURCE, xai-grok-shell 1.0.12 (bc7f02e) ──
 *
 * No grok binary was installed in this workspace, so unlike the sibling
 * experiments these facts are pinned by reading the shell's source, not by a
 * live run; this script is the live re-check for when a binary is available.
 * Source citations are files under crates/codegen/xai-grok-shell/src/.
 *
 * Wire: ACP over NDJSON-RPC 2.0 (agent-client-protocol 0.10.4), spawned as
 * `grok agent --always-approve --no-leader stdio`. Extension methods carry a
 * leading underscore on the wire per the ACP spec, so the JSON-RPC method is
 * `_x.ai/models/list`; the crate strips the prefix before dispatch
 * (mvp_agent/acp_agent.rs matches "x.ai/models/list"). The JSON-RPC result
 * wraps a second envelope `{result: SessionModelState}` or `{error: ...}` —
 * the reference client treats a handler error as winning over a missing
 * result (cli_models.rs parse_models_list_response).
 *
 * Semantics (handlers/models.rs, agent/models.rs, agent/config.rs,
 * mvp_agent/agent_ops.rs):
 * - Response is `SessionModelState { currentModelId, availableModels }` —
 *   grok is the only probed runtime whose list also names the CURRENT model.
 * - The catalog is a REMOTE fetch of /v1/models with the fetch credential
 *   resolved custom_endpoint > session > deployment > api key, and the URL
 *   itself auth-dependent (session auth → proxy.grok.com, API key →
 *   api.x.ai per remote/client_tests.rs). Disk-cached keyed by
 *   cache_origin + auth method + etag, refreshed in the background — the
 *   list is volatile; consumers get re-query semantics, not a constant.
 * - Filtering is usable-now at BOTH ends: `available()` keeps
 *   `user_selectable` entries, then `visible_for_auth(is_session_auth)` =
 *   `!hidden && (is_session_auth || supported_in_api)` — OAuth-only models
 *   are hidden from API-key users.
 * - Per-model `reasoning_efforts` menus with defaults
 *   (derive_reasoning_effort_fields); a per-session effort override is
 *   injected into the matching ModelInfo meta.
 * - BYOK: config `[model."<id>"]` entries with their own
 *   api_key/env_key/auth_provider/api_base_url MERGE into the catalog — the
 *   custom-model channel exists natively alongside the fetched list.
 * - Typed `AuthStatus` (ApiKey / LoggedIn / ModelCredentials /
 *   DeploymentKey / NotAuthenticated) backs the `grok models` banner, so
 *   "why is this list what it is" is answerable — never conflate
 *   "not logged in" with an empty list.
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

const bin = process.env.OAR_GROK_BIN ?? "grok";
const child = spawn(bin, ["agent", "--always-approve", "--no-leader", "stdio"], {
  stdio: ["pipe", "pipe", "inherit"],
});

let nextId = 0;
function send(method: string, params: unknown): number {
  const id = nextId;
  nextId += 1;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return id;
}

function unwrapResult(record: Record<string, unknown>): unknown {
  if (record.error !== undefined) {
    throw new Error(`rpc error: ${JSON.stringify(record.error)}`);
  }
  return record.result;
}

// Single line loop drives both sequential requests: the initialize response
// triggers the models/list request. Timeout by killing the child: stdout then
// ends, the loop exits without a response, and the assert below reports it.
const killTimer = setTimeout(() => {
  child.kill();
}, 60_000);
const initId = send("initialize", {
  protocolVersion: 1,
  clientCapabilities: { fs: {}, terminal: false },
});
let modelsId: number | null = null;
let raw: unknown = null;
let received = false;
for await (const line of createInterface({ input: child.stdout })) {
  const message = ((): unknown => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })();
  const record = asRecord(message);
  if (record !== null && modelsId === null && record.id === initId) {
    unwrapResult(record);
    modelsId = send("_x.ai/models/list", {});
  } else if (record !== null && modelsId !== null && record.id === modelsId) {
    raw = unwrapResult(record);
    received = true;
    break;
  }
}
clearTimeout(killTimer);
child.kill();
assert.ok(received, "stream ended before a models/list response (60s kill)");

const envelope = asRecord(raw);
assert.ok(envelope !== null, "ext result not an object");
assert.equal(envelope.error, undefined, `handler error: ${JSON.stringify(envelope.error)}`);
const state = asRecord(envelope.result) ?? envelope;
const models = asRecordList(state.availableModels ?? state.available_models);
assert.ok(models.length > 0, "availableModels empty");

process.stdout.write(`${JSON.stringify({
  currentModelId: state.currentModelId ?? state.current_model_id ?? null,
  totalModels: models.length,
  modelIds: models.map((model) => model.modelId ?? model.model_id),
}, null, 2)}\n`);
