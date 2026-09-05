/**
 * KIMI MODEL LIST — pins the `session/new` configOptions model surface.
 *
 * Run:
 *   OAR_KIMI_BIN=/path/to/kimi pnpm tsx experiments/kimi-list-models.ts
 * Exits non-zero on any unmet expectation. No tokens consumed (no prompt is
 * sent); a logged-in kimi is required because `session/new` is auth-gated.
 *
 * ── OBSERVED 2026-09-05 FROM SOURCE, kimi-code 0.41.0 (origin/main f9ca33376) ──
 *
 * No kimi binary was installed in this workspace, so these facts are pinned by
 * reading MoonshotAI/kimi-code, not by a live run; this script is the live
 * re-check for when a binary is available. Source citations are files under
 * packages/acp-server/src/ unless noted.
 *
 * Wire: ACP over NDJSON-RPC 2.0, spawned as `kimi acp`
 * (apps/kimi-code/src/cli/sub/acp.ts → runAcpServer). There is no dedicated
 * model-list method: the usable model list is delivered on every
 * `session/new` response as the `configOptions` entry with id "model".
 *
 * Handshake (server.ts):
 *   initialize   → { protocolVersion, agentCapabilities, authMethods: [{id: "login", …}] }
 *   authenticate → only methodId "login" is accepted (else invalidParams);
 *                  it re-runs the auth gate and returns {} when logged in.
 *   session/new  → ensureAuthed() first; when not logged in it throws
 *                  RequestError.authRequired() = JSON-RPC code -32000
 *                  "Authentication required". Then klient creates a session
 *                  and the reply is { sessionId, configOptions, modes }.
 *
 * configOptions (config-options.ts buildSessionConfigOptions):
 *   [ { type: "select", id: "model", name: "Model", category: "model",
 *       currentValue: <bare model id>,
 *       options: [{ value: model.id, name: model.name, description? }] },
 *     { id: "thinking", category: "thought_level", currentValue,
 *       options: [{ value, name: "Thinking <value>" }] }   // present only when
 *       // the currently selected model is thinkingSupported; values are
 *       // ["off", ...supportEfforts] or ["off", "on"]; alwaysThinking drops "off"
 *     { id: "mode", … } ]
 * Model entries come from kosong.listModels() projected by model-catalog.ts
 * (id = item.model, name = item.display_name ?? item.model). This is the
 * usable-now list for the logged-in account, not the models.dev catalog that
 * `kimi provider catalog list` prints.
 *
 * Consequences for oar: one session/new per listing (closed afterwards via
 * session/close); effort levels are only knowable for the current model.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
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

const bin = process.env.OAR_KIMI_BIN ?? "kimi";
const child = spawn(bin, ["acp"], { stdio: ["pipe", "pipe", "inherit"] });

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

// One line loop drives the sequential requests: initialize → authenticate
// (when the server advertises the "login" method) → session/new → session/close.
const killTimer = setTimeout(() => {
  child.kill();
}, 60_000);
const initId = send("initialize", {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: "oar-experiment", version: "0.0.0" },
});
let authId: number | null = null;
let newId: number | null = null;
let closeId: number | null = null;
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
  if (record === null || typeof record.id !== "number") {
    // notifications and unparseable lines
  } else if (record.id === initId) {
    const initialized = asRecord(unwrapResult(record)) ?? {};
    const hasLogin = asRecordList(initialized.authMethods).some((method) => method.id === "login");
    assert.ok(hasLogin, "initialize did not advertise the 'login' auth method");
    authId = send("authenticate", { methodId: "login" });
  } else if (record.id === authId) {
    unwrapResult(record);
    newId = send("session/new", { cwd: process.cwd(), mcpServers: [] });
  } else if (record.id === newId) {
    raw = unwrapResult(record);
    received = true;
    const sessionId = asRecord(raw)?.sessionId;
    if (typeof sessionId === "string") {
      closeId = send("session/close", { sessionId });
    } else {
      break;
    }
  } else if (record.id === closeId) {
    break;
  }
}
clearTimeout(killTimer);
child.kill();
assert.ok(received, "stream ended before a session/new response (60s kill)");

const response = asRecord(raw);
assert.ok(response !== null, "session/new result not an object");
const options = asRecordList(response.configOptions);
const modelOption = options.find((option) => option.id === "model");
assert.ok(modelOption !== undefined, "no configOptions entry with id 'model'");
assert.equal(modelOption.category, "model");
const models = asRecordList(modelOption.options);
assert.ok(models.length > 0, "model option lists no models");
const thinkingOption = options.find((option) => option.id === "thinking");

process.stdout.write(`${JSON.stringify({
  currentModel: modelOption.currentValue ?? null,
  totalModels: models.length,
  modelIds: models.map((model) => model.value),
  thinking: thinkingOption === undefined
    ? null
    : {
        currentValue: thinkingOption.currentValue ?? null,
        values: asRecordList(thinkingOption.options).map((option) => option.value),
      },
}, null, 2)}\n`);
