/**
 * Codex host runtime.
 *
 * Detect: `codex --version` (binary presence).
 * Models (xxchan / Huaihuai): **prefer live app-server `model/list`**, not the
 * stale `~/.codex/models_cache.json` file. Cache is fallback only when
 * app-server cannot answer (missing binary, timeout, protocol mismatch).
 *
 * App-server protocol (raft `detectCodexModelsFromAppServer` / drydock handshake):
 *   spawn `codex app-server --listen stdio://`
 *   → initialize → initialized → model/list (paginate nextCursor, max 5 pages)
 *
 * Absence vs zero (Huaihuai + archer):
 * - neither app-server nor cache → [] → models_unavailable
 * - catalog present → listed models + user-configured escape (empty options)
 * - user-configured options must stay [] (supported⇒required)
 *
 * Cache fixture (fallback path tests only):
 *   fixtures/codex-models_cache.sample.json
 */
import { readFileSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import {
  fileExists,
  modelsToInfo,
  type LiveModel,
} from "../runtimeProbe.js";
import { codexHome } from "../runtimePaths.js";
import { resolveCodexBin } from "../codexCommandResolution.js";
import { subprocessDriver, type HandshakeIo, type PromptIo } from "../../../backend/subprocessDriver.js";
import type { LaunchSpec } from "../../../backend/process/lifecycle.js";
import type { RuntimeDriver } from "../../../backend/runtimeDriver.js";
import type { ModelInfo } from "../../../config/model.js";
import type { RuntimeEvent } from "../../../events/event.js";
import { Diagnostic } from "../../../events/diagnostic.js";
import { model } from "../../../config/model.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const HANDSHAKE_TIMEOUT_MS = 15_000;

/**
 * codex app-server launch — newline-delimited JSON-RPC over stdio.
 * Reference: drydock/probes/codex-handshake.ts (codex 0.144.6).
 */
function codexPlan(): LaunchSpec {
  const r = resolveCodexBin();
  const command = r.ok ? r.command : "codex";
  return { command, args: ["app-server", "--listen", "stdio://"], env: {} };
}

/**
 * Codex app-server turn controller. Bundles the readiness handshake and the
 * per-turn `sendPrompt` because they share ONE piece of session state that oar's
 * stateless `normalise` cannot carry: the `threadId`.
 *
 * A user turn is submitted with `turn/start { threadId, input: [{type:"text",
 * text}] }` (raft daemon `codex.ts:1183-1186` + `codex.integration.test.ts:263-266,
 * 335-341`). `turn/start` REQUIRES an established `threadId`, and that id is only
 * obtained from a `thread/start` request/response round-trip (daemon
 * `codex.ts:753-794`; integration test drives `thread/start` before every
 * `turn/start`). `PromptIo` is fire-and-forget (send only, no `next()`), so the
 * round-trip must happen in the handshake — which owns `io.next()` — and the
 * resulting `threadId` is stashed here for `sendPrompt` to reuse.
 *
 * Single-active-session assumption: one controller instance backs one drive
 * session (`createHostDrivers()` builds a fresh `codexDriver()` per call and
 * `oar drive` starts exactly one session). Concurrent sessions from one instance
 * would share/overwrite `threadId`; that is out of scope for the drive/conformance
 * path and is reset at the start of each handshake.
 */
interface CodexTurnController {
  handshake: (io: HandshakeIo) => Promise<void>;
  sendPrompt: (io: PromptIo, text: string) => void;
}

function makeCodexTurnController(): CodexTurnController {
  let threadId: string | null = null;
  let requestId = 0;
  const nextId = (): number => (requestId += 1);

  /**
   * The REAL readiness witness (not `process_spawned`): `initialize` → id-matched
   * response carrying `userAgent` → `initialized` → `thread/start` → id-matched
   * response carrying `result.thread.id`. Tolerates unsolicited / out-of-order
   * notifications (codex-handshake.ts FINDING 3): only the id-matched responses
   * are witnesses; anything else is ignored while we keep waiting. Establishing
   * the thread here (not just `initialized`) is what lets `sendPrompt` submit a
   * turn — it mirrors the daemon, which always establishes a thread before its
   * first turn.
   */
  async function handshake(io: HandshakeIo): Promise<void> {
    threadId = null;
    requestId = 0;
    const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS;

    const nextFrame = async (what: string): Promise<Record<string, unknown>> => {
      for (;;) {
        if (Date.now() > deadline) {
          throw new Error(`codex: no ${what} response within ${String(HANDSHAKE_TIMEOUT_MS)}ms`);
        }
        const line = await io.next();
        if (line === null) {
          throw new Error(`codex: app-server closed before completing the ${what} handshake`);
        }
        let msg: unknown = null;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // non-JSON noise — tolerate, keep waiting
        }
        if (isRecord(msg)) return msg;
        // non-object JSON — tolerate, keep waiting
      }
    };

    // 1) initialize → userAgent witness → initialized
    const initId = nextId();
    io.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: initId,
        method: "initialize",
        params: { clientInfo: { name: "oar", version: "0.0.0" }, capabilities: { experimentalApi: true } },
      }),
    );
    for (;;) {
      const msg = await nextFrame("initialize");
      if (msg.id !== initId) continue; // unsolicited notification / other id — tolerate
      if (msg.error !== undefined || !isRecord(msg.result) || typeof msg.result.userAgent !== "string") {
        throw new Error("codex: initialize failed or missing userAgent handshake field");
      }
      io.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }));
      break;
    }

    // 2) thread/start → threadId witness. Non-interactive driving params mirror
    //    the daemon (`codex.ts:759-768`) / integration test (`:326-331`):
    //    approvalPolicy "never" + full-access sandbox so a turn cannot hang on an
    //    approval prompt. experimentalRawEvents is deliberately NOT set (oar does
    //    not consume raw events; stays off the experimental surface).
    const threadStartId = nextId();
    io.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: threadStartId,
        method: "thread/start",
        params: { cwd: process.cwd(), approvalPolicy: "never", sandbox: "danger-full-access" },
      }),
    );
    for (;;) {
      const msg = await nextFrame("thread/start");
      if (msg.id !== threadStartId) continue; // unsolicited notification / other id — tolerate
      if (msg.error !== undefined) {
        throw new Error("codex: thread/start failed");
      }
      const thread = isRecord(msg.result) ? msg.result.thread : undefined;
      const id = isRecord(thread) ? thread.id : undefined;
      if (typeof id !== "string" || id.length === 0) {
        throw new Error("codex: thread/start response missing thread.id");
      }
      threadId = id;
      return; // READY — a real handshake witness AND an established thread
    }
  }

  /**
   * Submit a user turn: `turn/start { threadId, input: [{type:"text", text}] }`.
   * Throws if no thread was established (handshake did not complete), rather than
   * silently sending an unaddressed turn.
   */
  function sendPrompt(io: PromptIo, text: string): void {
    if (threadId === null) {
      throw new Error("codex: no established thread (handshake did not complete thread/start)");
    }
    io.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: nextId(),
        method: "turn/start",
        params: { threadId, input: [{ type: "text", text }] },
      }),
    );
  }

  return { handshake, sendPrompt };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Assistant-text phase gate (raft `codexEventNormalizer.ts:217-219`): codex tags
 * agent messages with a `phase`; only `final_answer` (or an absent phase) is the
 * user-visible answer. Other phases (e.g. `commentary`) are tool-preamble scaffolding.
 */
function isUserVisibleAgentPhase(phase: string | null): boolean {
  return phase === null || phase === "final_answer";
}

/**
 * codex item.type → oar tool name (raft `codexEventNormalizer.ts:466-569`).
 * Returns `null` for item types that are not tool calls (agentMessage, reasoning,
 * contextCompaction, review modes, …). `fileChange` is intentionally excluded: the
 * reference fans one `fileChange` item out to N tool calls (one per changed path,
 * `:502-534`) with no per-change id, which has no clean mapping onto oar's single
 * `callId`-per-call envelope — so it is tolerated rather than mapped by guesswork.
 */
function codexToolName(item: Record<string, unknown>): string | null {
  switch (item.type) {
    case "commandExecution":
      return "shell"; // raft codexEventNormalizer.ts:466-475
    case "webSearch":
      return "web_search"; // raft codexEventNormalizer.ts:560-569
    case "collabAgentToolCall":
      return "collab_tool_call"; // raft codexEventNormalizer.ts:549-558
    case "mcpToolCall": {
      // raft codexEventNormalizer.ts:196-200 (codexMcpToolName)
      const tool = nonEmptyString(item.tool) ?? "unknown";
      const server = nonEmptyString(item.server);
      return server ? `mcp_${server}_${tool}` : `mcp_${tool}`;
    }
    default:
      return null;
  }
}

/**
 * Frame → oar `RuntimeEvent`s for the codex app-server turn protocol, extracted
 * from raft's production daemon driver (`packages/daemon/src/drivers/codexEventNormalizer.ts`).
 * Stateless and per-frame: TOLERATES unsolicited / out-of-order / unrecognised
 * frames by returning `[]` rather than desyncing.
 *
 * Method → event mapping (raft file:line is the authority for each):
 * - JSON-RPC error response (top-level `error`)     → `runtime_error`
 * - JSON-RPC success response (top-level `result`)   → `[]` (thread/turn accept — handshake owns thread; turn accept carries no turn content). raft `:276-292`
 * - `item/completed` item.type `agentMessage`        → `text` (item.text), phase-gated on the item's own `phase`. raft `:447-464`
 * - `item/agentMessage/delta`                        → `[]` — the daemon's streamed delta path (`:347-364`) needs a cross-frame phase cache (phase is set on `item/started` and omitted on later deltas) that a stateless mapper cannot hold; oar surfaces the phase-gated text at completion instead.
 * - `item/started`  tool item (shell/mcp/web/collab) → `tool_call{callId=item.id, name}`. raft `:466-569`
 * - `item/completed` tool item                       → `tool_result{callId=item.id, ok:true}`. raft `:466-569`
 *     ⚠️ `ok` HAS NO PER-TOOL SOURCE in the reference: the daemon emits a bare
 *     `tool_output` (name only) on completion and surfaces failures only at the
 *     TURN level (`turn/completed` status, `:574-615`). `item/completed` is the
 *     resolution signal, so `ok:true` = "the call resolved (no item-level failure
 *     channel exists)". This is the single field oar asks for that codex does not
 *     report per-item — flagged for the non-author reviewer.
 * - `turn/completed` status `completed`              → `turn_end{completed}`. raft `:585-614`
 * - `turn/completed` status `failed`                 → `runtime_error` + `turn_end{crashed}`. raft `:576-577,609-614`
 * - `turn/completed` status `interrupted`            → `turn_end{interrupted}`. raft `:579-583` (daemon also emits an error; oar carries the interruption in `turn_end.reason`).
 * - `error` notification, `willRetry:true`           → `[]` (retryable progress). raft `:617-620`
 * - `error` notification, otherwise                  → `runtime_error`. raft `:621-626`
 * - everything else (turn/started, reasoning deltas, telemetry, thread/status, …) → `[]`.
 *
 * Not represented (no oar event kind): reasoning/thinking text, token-usage
 * telemetry (a separate `thread/tokenUsage/updated` frame, so it cannot be
 * attached to `turn_end.usage` by a stateless per-frame mapper), compaction, and
 * review-mode transitions — all tolerated.
 */
export function codexNormalise(raw: unknown): readonly RuntimeEvent[] {
  if (!isRecord(raw)) return [];

  // JSON-RPC error response.
  if (isRecord(raw.error)) {
    const message = typeof raw.error.message === "string" ? raw.error.message : "codex app-server error";
    return [{ kind: "runtime_error", detail: Diagnostic.fromRaw("unknown", message) }];
  }

  // JSON-RPC success response (thread/turn accept, model/list, …): no turn content.
  if (isRecord(raw.result)) return [];

  const method = typeof raw.method === "string" ? raw.method : "";
  const params = isRecord(raw.params) ? raw.params : {};

  switch (method) {
    case "item/agentMessage/delta":
      // Streamed deltas need cross-frame phase state a stateless mapper lacks;
      // text is surfaced at item/completed instead. Tolerate.
      return [];

    case "item/started":
    case "item/completed": {
      const item = isRecord(params.item) ? params.item : null;
      if (!item || typeof item.type !== "string") return [];

      if (item.type === "agentMessage") {
        // Assistant text: only on completion, only user-visible phase.
        if (method !== "item/completed") return [];
        const phase = nonEmptyString(item.phase);
        const text = nonEmptyString(item.text);
        if (!text || !isUserVisibleAgentPhase(phase)) return [];
        return [{ kind: "text", text }];
      }

      const name = codexToolName(item);
      if (name === null) return []; // non-tool item type — tolerate
      const callId = nonEmptyString(item.id);
      if (callId === null) return []; // no id → cannot form a call envelope
      return method === "item/started"
        ? [{ kind: "tool_call", callId, name }]
        : [{ kind: "tool_result", callId, ok: true }];
    }

    case "turn/completed": {
      const turn = isRecord(params.turn) ? params.turn : null;
      const status = turn && typeof turn.status === "string" ? turn.status : "completed";
      if (status === "failed") {
        const turnError = turn && isRecord(turn.error) ? turn.error : null;
        const message = (turnError && nonEmptyString(turnError.message)) ?? "Codex turn failed";
        return [
          { kind: "runtime_error", detail: Diagnostic.fromRaw("crashed", message) },
          { kind: "turn_end", reason: "crashed" },
        ];
      }
      if (status === "interrupted") {
        return [{ kind: "turn_end", reason: "interrupted" }];
      }
      return [{ kind: "turn_end", reason: "completed" }];
    }

    case "error": {
      if (params.willRetry === true) return []; // retryable — progress, not terminal
      const message =
        nonEmptyString(params.message) ??
        (isRecord(params.error) ? nonEmptyString(params.error.message) : null) ??
        "codex app-server error";
      return [{ kind: "runtime_error", detail: Diagnostic.fromRaw("unknown", message) }];
    }

    default:
      return [];
  }
}

/** Sentinel model: caps unknown; zero options (supported⇒required forbids guessing). */
export const CODEX_USER_CONFIGURED: ModelInfo = model(
  "user-configured",
  "User-configured (isolated config dir)",
  [],
);

type CacheRow = {
  slug?: string;
  display_name?: string;
  supported_reasoning_levels?: Array<{ effort?: string }>;
  additional_speed_tiers?: string[];
  service_tiers?: Array<{ id?: string }>;
  visibility?: string;
};

export type CodexCacheBody = {
  models?: CacheRow[];
  fetched_at?: string;
};

function withUserConfigured(listed: readonly ModelInfo[]): readonly ModelInfo[] {
  if (listed.some((m) => m.id === "user-configured")) return listed;
  return [...listed, CODEX_USER_CONFIGURED];
}

/**
 * Pure parse of models_cache.json body — unit-tested without the filesystem.
 * Fallback path only when app-server model/list is unavailable.
 *
 * Fixture: fixtures/codex-models_cache.sample.json
 */
export function parseCodexModelsCache(raw: CodexCacheBody): {
  models: readonly ModelInfo[];
  hadNonList: boolean;
} {
  const live: LiveModel[] = [];
  let hadNonList = false;
  for (const m of raw.models ?? []) {
    if (!m.slug) continue;
    if (m.visibility && m.visibility !== "list" && m.visibility !== "public") {
      hadNonList = true;
      continue;
    }
    const entry: LiveModel = {
      id: m.slug,
      label: m.display_name ?? m.slug,
      supportedReasoningEfforts: (m.supported_reasoning_levels ?? [])
        .map((x) => x.effort)
        .filter((x): x is string => Boolean(x)),
      serviceTiers: (m.service_tiers ?? [])
        .map((s) => s.id)
        .filter((x): x is string => Boolean(x)),
    };
    if (m.additional_speed_tiers) entry.additionalSpeedTiers = m.additional_speed_tiers;
    live.push(entry);
  }
  return { models: withUserConfigured(modelsToInfo("codex", live)), hadNonList };
}

/** Prefer cache body fetched_at; else file mtime ISO. */
export function codexCacheAsOf(
  cachePath: string,
  body: CodexCacheBody | null,
): string | undefined {
  if (body?.fetched_at && typeof body.fetched_at === "string") return body.fetched_at;
  try {
    return statSync(cachePath).mtime.toISOString();
  } catch {
    return undefined;
  }
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function modelListPage(result: unknown): { entries: unknown[]; nextCursor: string | null } | null {
  if (!result || typeof result !== "object") return null;
  const object = result as { data?: unknown; models?: unknown; nextCursor?: unknown };
  let entries: unknown[] | null = null;
  if (Array.isArray(object.data)) entries = object.data;
  else if (Array.isArray(object.models)) entries = object.models;
  if (!entries) return null;
  return {
    entries,
    nextCursor: asNonEmptyString(object.nextCursor),
  };
}

function liveFromAppServerEntry(entry: unknown): LiveModel | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const object = entry as Record<string, unknown>;
  if (object.hidden === true) return null;

  const id =
    asNonEmptyString(object.id) ??
    asNonEmptyString(object.model) ??
    asNonEmptyString(object.slug);
  if (!id) return null;

  const label =
    asNonEmptyString(object.displayName) ??
    asNonEmptyString(object.display_name) ??
    asNonEmptyString(object.label) ??
    id;

  const effortsRaw = object.supportedReasoningEfforts ?? object.supported_reasoning_levels;
  const supportedReasoningEfforts: string[] = [];
  if (Array.isArray(effortsRaw)) {
    for (const e of effortsRaw) {
      if (typeof e === "string" && e.trim()) supportedReasoningEfforts.push(e.trim());
      else if (e && typeof e === "object") {
        const o = e as { effort?: unknown; reasoningEffort?: unknown; id?: unknown };
        const v =
          asNonEmptyString(o.effort) ??
          asNonEmptyString(o.reasoningEffort) ??
          asNonEmptyString(o.id);
        if (v) supportedReasoningEfforts.push(v);
      }
    }
  }

  const out: LiveModel = { id, label };
  if (supportedReasoningEfforts.length > 0) out.supportedReasoningEfforts = supportedReasoningEfforts;
  return out;
}

/**
 * Live model list via `codex app-server` JSON-RPC `model/list`.
 * Returns null on any failure (caller falls back to cache).
 */
export function detectCodexModelsFromAppServer(opts: {
  timeoutMs?: number;
  codexBin?: string;
} = {}): Promise<readonly ModelInfo[] | null> {
  let bin = opts.codexBin ?? null;
  if (!bin) {
    const r = resolveCodexBin();
    bin = r.ok ? r.command : null;
  }
  if (!bin) return Promise.resolve(null);
  const timeoutMs = opts.timeoutMs ?? 8_000;

  return new Promise((resolve) => {
    const proc = spawn(bin, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "ignore"],
      env: process.env,
    });
    let buffer = "";
    let requestId = 0;
    let initializeRequestId: number | null = null;
    let modelListRequestId: number | null = null;
    let pageCount = 0;
    const entries: unknown[] = [];

    // Single-settle: drop the resolve handle after first call so oxlint is happy
    // and exit/timeout races cannot double-resolve.
    let settle: ((result: readonly ModelInfo[] | null) => void) | null = (result) => {
      settle = null;
      clearTimeout(timer);
      proc.stdout?.removeAllListeners("data");
      proc.removeAllListeners("error");
      proc.removeAllListeners("exit");
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore
      }
      // Guarded by settle=null above; multiple event sources call finish().
      // oxlint-disable-next-line promise/no-multiple-resolved -- settle nullified first
      resolve(result);
    };
    const finish = (result: readonly ModelInfo[] | null) => {
      settle?.(result);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);

    const sendRequest = (method: string, params: Record<string, unknown>): number => {
      requestId += 1;
      const id = requestId;
      proc.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return id;
    };
    const sendNotification = (method: string, params: Record<string, unknown>) => {
      proc.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    };
    const requestModelPage = (cursor: string | null) => {
      pageCount += 1;
      modelListRequestId = sendRequest("model/list", cursor ? { cursor } : {});
    };

    proc.once("error", () => {
      finish(null);
    });
    // Only treat unexpected exit as failure; finish() kills the process after success.
    proc.once("exit", () => {
      finish(null);
    });
    proc.stdout?.on("data", (chunk: Buffer | string) => {
      if (!settle) return;
      buffer += chunk.toString();
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;

        let message: unknown = null;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (!message || typeof message !== "object") continue;
        const msg = message as { id?: unknown; result?: unknown; error?: unknown; method?: unknown };
        // Notifications / unsolicited — ignore (FINDING 3 in drydock probe).
        if (msg.method !== undefined && msg.id === undefined) continue;
        if (msg.id === undefined) continue;

        if (msg.id === initializeRequestId) {
          if (msg.error !== undefined || msg.result === undefined) {
            finish(null);
            return;
          }
          const result = msg.result as { userAgent?: unknown };
          if (typeof result.userAgent !== "string") {
            finish(null);
            return;
          }
          sendNotification("initialized", {});
          requestModelPage(null);
          continue;
        }

        if (msg.id === modelListRequestId) {
          if (msg.error !== undefined || msg.result === undefined) {
            finish(null);
            return;
          }
          const page = modelListPage(msg.result);
          if (!page) {
            finish(null);
            return;
          }
          entries.push(...page.entries);
          if (page.nextCursor && pageCount < 5) {
            requestModelPage(page.nextCursor);
            continue;
          }
          const live: LiveModel[] = [];
          for (const e of entries) {
            const m = liveFromAppServerEntry(e);
            if (m) live.push(m);
          }
          if (live.length === 0) {
            finish(null);
            return;
          }
          finish(withUserConfigured(modelsToInfo("codex", live)));
          return;
        }
      }
    });

    initializeRequestId = sendRequest("initialize", {
      clientInfo: { name: "oar", version: "0.0.0" },
      capabilities: { experimentalApi: true },
    });
  });
}

function modelsFromCacheFallback(): readonly ModelInfo[] {
  // CODEX_HOME-aware (was hard-coded ~/.codex); shared root via host/runtimePaths.ts.
  const cache = codexHome("models_cache.json");
  if (!fileExists(cache)) return [];
  try {
    const raw = JSON.parse(readFileSync(cache, "utf8")) as CodexCacheBody;
    return parseCodexModelsCache(raw).models;
  } catch {
    return [];
  }
}

export function codexDriver(): RuntimeDriver {
  const turn = makeCodexTurnController();
  return subprocessDriver({
    id: "codex",
    // Version from the arbitrated, app-server-capable binary (CODEX_BIN / PATH /
    // ChatGPT.app bundle), not a bare PATH `codex --version`. Fail-closed: a
    // set-but-unusable CODEX_BIN yields not-detected, never a PATH fallthrough.
    detect: async () => {
      const r = resolveCodexBin();
      if (!r.ok) return null;
      return { version: r.version ?? r.command };
    },
    models: async () => {
      const r = resolveCodexBin();
      const bin = r.ok ? r.command : null;
      const live = bin ? await detectCodexModelsFromAppServer({ codexBin: bin }) : null;
      if (live && live.length > 0) return live;
      // Fallback: file cache (may be stale). Prefer empty typed failure over lying.
      return modelsFromCacheFallback();
    },
    // Drive-layer: real launch + handshake witness (initialize + thread/start) +
    // tolerant normalise + a wired user-turn submitter (turn/start).
    plan: codexPlan,
    readiness: { kind: "handshake_event" },
    handshake: turn.handshake,
    sendPrompt: turn.sendPrompt,
    normalise: codexNormalise,
    shutdown: { graceMs: 2_000, onGraceExpiry: "immediate" },
  });
}
