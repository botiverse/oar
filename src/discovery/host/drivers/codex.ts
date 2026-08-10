/**
 * Codex host runtime.
 *
 * Detect: `codex --version` (binary presence) + optional models_cache freshness.
 * Models: pure-read of ~/.codex/models_cache.json (written by the Codex app/CLI).
 *
 * Why not app-server for model list (HaoHao, historical): shortest path when
 * detect was first wired — not a deliberate rejection of app-server. app-server
 * is marked [experimental] and is the long-lived JSON-RPC surface used for
 * session lifecycle (drydock/probes/codex-handshake.ts). Long-term correctness
 * wants live query; this round keeps the cache path but always surfaces its
 * timestamp so consumers can see staleness (HaoHao (a)).
 *
 * Absence vs zero (Huaihuai + archer):
 * - cache file missing → [] → detect maps to models_unavailable (not "ready").
 * - cache present → listed models + user-configured escape (empty options).
 * - user-configured options must stay [] because supported⇒required (archer (c)).
 */
import { readFileSync, statSync } from "node:fs";
import {
  baseDriver,
  versionVia,
  home,
  fileExists,
  modelsToInfo,
  type LiveModel,
} from "../probe.js";
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

/**
 * Pure parse of models_cache.json body — unit-tested without the filesystem.
 *
 * Fixture (parser tests load the same file):
 *   fixtures/codex-models_cache.sample.json
 * Parsed → listed models with caps + trailing user-configured escape;
 *          visibility≠"list" rows dropped (hadNonList=true).
 */
export function parseCodexModelsCache(raw: CodexCacheBody): {
  models: readonly ModelInfo[];
  hadNonList: boolean;
} {
  const live: LiveModel[] = [];
  let hadNonList = false;
  for (const m of raw.models ?? []) {
    if (!m.slug) continue;
    if (m.visibility && m.visibility !== "list") {
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
  const listed = modelsToInfo("codex", live);
  if (listed.some((m) => m.id === "user-configured")) {
    return { models: listed, hadNonList };
  }
  // Always append escape when cache was successfully parsed (fixture parity).
  return { models: [...listed, CODEX_USER_CONFIGURED], hadNonList };
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

export function codexDriver(): RuntimeDriver {
  return baseDriver("codex", {
    detect: async () => {
      const ver = await versionVia("codex");
      if (!ver) return null;
      const cache = home(".codex", "models_cache.json");
      if (!fileExists(cache)) {
        // Binary present; catalog source unknown — version only.
        return ver;
      }
      let body: CodexCacheBody | null = null;
      try {
        body = JSON.parse(readFileSync(cache, "utf8")) as CodexCacheBody;
      } catch {
        body = null;
      }
      const asOf = codexCacheAsOf(cache, body);
      // Encode freshness on version for human table until RuntimeDescriptor
      // grows a dedicated sourceAsOf field (v1 JSON stays narrow).
      if (asOf) {
        return { version: `${ver.version}  cacheAsOf=${asOf}` };
      }
      return ver;
    },
    models: async () => {
      const cache = home(".codex", "models_cache.json");
      // Missing cache: empty → detect layer yields models_unavailable.
      // Do NOT invent user-configured — zero evidence of any catalog.
      if (!fileExists(cache)) return [];
      try {
        const raw = JSON.parse(readFileSync(cache, "utf8")) as CodexCacheBody;
        return parseCodexModelsCache(raw).models;
      } catch {
        return [];
      }
    },
  });
}
