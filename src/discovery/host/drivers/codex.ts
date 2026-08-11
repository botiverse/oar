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
  baseDriver,
  fileExists,
  modelsToInfo,
  type LiveModel,
} from "../probe.js";
import { codexHome } from "../paths.js";
import { resolveCodexBin } from "../codexResolve.js";
import type { RuntimeDriver } from "../../../backend/trait.js";
import type { ModelInfo } from "../../../config/model.js";
import { model } from "../../../config/model.js";

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
  // CODEX_HOME-aware (was hard-coded ~/.codex); shared root via host/paths.ts.
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
  return baseDriver("codex", {
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
  });
}
