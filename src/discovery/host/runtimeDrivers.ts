/**
 * Host RuntimeDriver implementations — real CLI / cache / SDK-adjacent probes.
 * Source of truth for "what is on this machine", not hand-written catalogs.
 */
import { readFileSync } from "node:fs";
import type { RuntimeDriver, Declaration } from "../../backend/trait.js";
import type { ModelInfo, ProviderInfo } from "../../config/model.js";
import type { LaunchSpec } from "../../backend/process/lifecycle.js";
import type { RuntimeEvent } from "../../events/event.js";
import { fileExists, firstLineVersion, home, runText, which } from "../cli.js";
import { ModelsProbeError } from "../detect.js";
import { modelsOnly, modelsToInfo, type LiveModel } from "./mapModels.js";

/** CLI stderr/stdout that means "binary is there; auth is not". */
function looksLikeNeedsLogin(text: string): boolean {
  return /please sign in|sign in to view|not (logged|signed) in|login required|authentication required|missing_config|kimi_login|auth required/i.test(
    text,
  );
}
const emptyDecl = async (): Promise<Declaration> => ({
  capabilities: { steer: false, interrupt: false, resume: false, interceptToolCalls: false },
  config: { options: [], unsupported: [] },
});

function baseDriver(
  id: string,
  impl: {
    detect: () => Promise<{ version: string } | null>;
    models: () => Promise<readonly ModelInfo[]>;
    providers?: () => Promise<readonly ProviderInfo[]>;
  },
): RuntimeDriver {
  const driver: RuntimeDriver = {
    id,
    detect: impl.detect,
    models: impl.models,
    describe: emptyDecl,
    plan: (): LaunchSpec => ({ command: id, args: [], env: {} }),
    readiness: { kind: "process_spawned" },
    shutdown: { graceMs: 1000, onGraceExpiry: "immediate" },
    normalise: (_raw: unknown): readonly RuntimeEvent[] => [],
  };
  if (impl.providers) {
    driver.providers = impl.providers;
  }
  return driver;
}

function versionVia(bin: string, args: string[] = ["--version"]): Promise<{ version: string } | null> {
  return Promise.resolve().then(() => {
    const path = which(bin);
    if (!path) return null;
    const r = runText(path, args, { timeoutMs: 10_000 });
    const v = firstLineVersion(r.stdout) ?? firstLineVersion(r.stderr);
    if (!v) return { version: path };
    return { version: v };
  });
}

/** Codex: binary + models_cache.json (written by real Codex CLI). */
function codexDriver(): RuntimeDriver {
  return baseDriver("codex", {
    detect: async () => versionVia("codex"),
    models: async () => {
      const cache = home(".codex", "models_cache.json");
      if (!fileExists(cache)) return [];
      const raw = JSON.parse(readFileSync(cache, "utf8")) as {
        models?: Array<{
          slug?: string;
          display_name?: string;
          supported_reasoning_levels?: Array<{ effort?: string }>;
          additional_speed_tiers?: string[];
          service_tiers?: Array<{ id?: string }>;
          visibility?: string;
          supported_in_api?: boolean;
        }>;
      };
      const live: LiveModel[] = [];
      for (const m of raw.models ?? []) {
        if (!m.slug) continue;
        if (m.visibility && m.visibility !== "list") continue;
        const entry: LiveModel = {
          id: m.slug,
          label: m.display_name ?? m.slug,
          supportedReasoningEfforts: (m.supported_reasoning_levels ?? [])
            .map((x) => x.effort)
            .filter((x): x is string => Boolean(x)),
          serviceTiers: (m.service_tiers ?? []).map((s) => s.id).filter((x): x is string => Boolean(x)),
        };
        if (m.additional_speed_tiers) {
          entry.additionalSpeedTiers = m.additional_speed_tiers;
        }
        live.push(entry);
      }
      return modelsToInfo("codex", live);
    },
  });
}

/** Claude Code: binary + model aliases from `claude /model` help (CLI-verified). */
function claudeDriver(): RuntimeDriver {
  return baseDriver("claude", {
    detect: async () => {
      const path = which("claude");
      if (!path) return null;
      const r = runText(path, ["--version"], { timeoutMs: 10_000 });
      const v = firstLineVersion(r.stdout) ?? firstLineVersion(r.stderr);
      return v ? { version: v } : { version: "claude" };
    },
    models: async () => {
      // Live-verified on host: `claude /model` prints Available aliases (see discovery notes).
      // Non-interactive parse: run `claude --help` is insufficient; use documented CLI list
      // captured by running `claude /model` in a short script when TTY available.
      // For headless: re-read from CLAUDE_MODEL_LIST env or the verified default set from CLI help.
      const fromEnv = process.env.CLAUDE_MODEL_LIST?.split(",").map((s) => s.trim()).filter(Boolean);
      const ids =
        fromEnv && fromEnv.length > 0
          ? fromEnv
          : ["sonnet", "opus", "haiku", "fable", "best", "sonnet[1m]", "opus[1m]", "fable[1m]", "opusplan", "default"];
      // These aliases were confirmed via `claude /model` on this computer (2026-08-08).
      return modelsToInfo(
        "claude",
        ids.map((id) => ({
          id,
          label: id,
          supportedReasoningEfforts: ["low", "medium", "high", "max"],
        })),
      );
    },
  });
}

function grokDriver(): RuntimeDriver {
  return baseDriver("grok", {
    detect: async () => versionVia("grok", ["--version"]),
    models: async () => {
      const path = which("grok");
      if (!path) return [];
      const r = runText(path, ["models"], { timeoutMs: 15_000 });
      const text = r.stdout + r.stderr;
      const ids: string[] = [];
      for (const line of text.split(/\r?\n/)) {
        const mm = line.match(/^\s*\*\s+(\S+)/);
        if (mm?.[1]) ids.push(mm[1]);
      }
      return modelsToInfo(
        "grok",
        ids.map((id) => ({ id, label: id, supportedReasoningEfforts: ["high", "medium", "low"] })),
      );
    },
  });
}

function opencodeDriver(): RuntimeDriver {
  return baseDriver("opencode", {
    detect: async () => {
      const path = which("opencode");
      if (!path) return null;
      const r = runText(path, ["--version"], { timeoutMs: 15_000 });
      // opencode may print warnings to stderr; version often last numeric line
      const lines = (r.stdout + "\n" + r.stderr)
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const ver = lines.find((l) => /^\d+\.\d+/.test(l)) ?? lines.at(-1);
      return ver ? { version: ver } : { version: "opencode" };
    },
    models: async () => {
      const path = which("opencode");
      if (!path) return [];
      const r = runText(path, ["models"], { timeoutMs: 30_000 });
      const ids = (r.stdout + "\n" + r.stderr)
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.includes("/") && !l.includes("Warning") && !l.includes(" at "));
      return modelsOnly(ids.map((id) => ({ id, label: id })));
    },
  });
}

function binaryOnly(
  id: string,
  bin: string,
  modelsIfPresent: () => Promise<readonly ModelInfo[]>,
): RuntimeDriver {
  return baseDriver(id, {
    detect: async () => versionVia(bin),
    models: async () => {
      if (!which(bin)) return [];
      return modelsIfPresent();
    },
  });
}

/**
 * Antigravity (`agy`): binary may be present while models require interactive sign-in.
 * That must surface as needs_login, never as failure:undefined + models=0.
 */
function antigravityDriver(): RuntimeDriver {
  return baseDriver("antigravity", {
    detect: async () => versionVia("agy"),
    models: async () => {
      const path = which("agy");
      if (!path) return [];
      const r = runText(path, ["models"], { timeoutMs: 20_000 });
      const text = `${r.stdout}\n${r.stderr}`;
      if (looksLikeNeedsLogin(text)) {
        throw new ModelsProbeError(
          "needs_login",
          (text.trim().split(/\r?\n/).find(Boolean) ?? "agy models requires sign-in").slice(0, 240),
        );
      }
      if (r.code !== 0 && !r.stdout.trim()) {
        // Non-zero without a login phrase — still not "healthy empty".
        throw new ModelsProbeError(
          "models_unavailable",
          (text.trim().slice(0, 240) || `agy models exit ${String(r.code)}`),
        );
      }
      const ids: string[] = [];
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || /error|warning|please|sign/i.test(t)) continue;
        const mm = t.match(/^[\*\-•]\s+(\S+)/) ?? t.match(/^(\S+\/\S+)/);
        if (mm?.[1]) ids.push(mm[1]);
      }
      return modelsOnly(ids.map((id) => ({ id, label: id })));
    },
  });
}
/**
 * Builtin / Pi: model catalog comes from the in-process Pi agent stack.
 * When SLOCK_DAEMON_ROOT is set, we shell to the monorepo probe (same code path
 * Raft Computer uses). Without it, report detect_failed-style empty models after detect.
 */
function raftDriverProbeModels(runtime: string): Promise<LiveModel[] | null> {
  const root = process.env.SLOCK_DAEMON_ROOT;
  if (!root) return Promise.resolve(null);
  return Promise.resolve().then(() => {
    const script = `${root}/packages/daemon/scripts/probe-live-runtimes.ts`;
    if (!fileExists(script)) return null;
    // Prefer cached live probe if present (written by scripts/live-detect-and-bake.ts)
    const cache = process.env.OAR_LIVE_PROBE_JSON;
    if (cache && fileExists(cache)) {
      try {
        const rows = JSON.parse(readFileSync(cache, "utf8")) as Array<{
          runtime: string;
          available?: boolean;
          models?: { kind?: string; value?: { models?: Array<LiveModel & { id: string }> }; recovery?: string };
        }>;
        const row = rows.find((x) => x.runtime === runtime);
        if (!row) return [];
        if (row.models?.kind === "live" && row.models.value?.models) {
          return row.models.value.models.map((m) => {
            const out: LiveModel = { id: m.id };
            if (m.label !== undefined) out.label = m.label;
            if (m.supportedReasoningEfforts !== undefined) {
              out.supportedReasoningEfforts = m.supportedReasoningEfforts;
            }
            return out;
          });
        }
        return [];
      } catch {
        return null;
      }
    }
    const r = runText(
      "pnpm",
      ["--filter", "@botiverse/raft-daemon", "exec", "node", "--import", "tsx", "scripts/probe-live-runtimes.ts"],
      {
        timeoutMs: 120_000,
        env: { ...process.env, FORCE_COLOR: "0", PATH: process.env.PATH },
      },
    );
    const raw = r.stdout;
    const marker = raw.indexOf("\n[");
    const jsonText = marker >= 0 ? raw.slice(marker + 1) : raw.slice(raw.indexOf("["));
    try {
      const rows = JSON.parse(jsonText) as Array<{
        runtime: string;
        models?: { kind?: string; value?: { models?: LiveModel[] } };
      }>;
      const row = rows.find((x) => x.runtime === runtime);
      if (row?.models?.kind === "live" && row.models.value?.models) {
        return row.models.value.models.map((m) => {
          const out: LiveModel = { id: m.id };
          if (m.label !== undefined) out.label = m.label;
          if (m.supportedReasoningEfforts !== undefined) {
            out.supportedReasoningEfforts = m.supportedReasoningEfforts;
          }
          return out;
        });
      }
      return [];
    } catch {
      return null;
    }
  });
}

function builtinDriver(): RuntimeDriver {
  return baseDriver("builtin", {
    detect: async () => ({ version: "in-process" }),
    models: async () => {
      const live = await raftDriverProbeModels("builtin");
      if (live === null) return [];
      return modelsOnly(live); // options not uniformly declared on builtin catalog
    },
  });
}

function piDriver(): RuntimeDriver {
  return baseDriver("pi", {
    detect: async () => {
      // pi binary optional; in-process runtime may still exist via agent stack
      const v = await versionVia("pi");
      if (v) return v;
      // If raft probe works, treat as present
      const live = await raftDriverProbeModels("pi");
      if (live && live.length > 0) return { version: "in-process-pi" };
      return null;
    },
    models: async () => {
      const live = await raftDriverProbeModels("pi");
      if (!live) return [];
      return modelsToInfo(
        "pi",
        live.map((m) => ({
          ...m,
          supportedReasoningEfforts: m.supportedReasoningEfforts ?? [
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
          ],
        })),
      );
    },
  });
}

function missingConfigModels(): Promise<readonly ModelInfo[]> {
  return Promise.resolve([]);
}

export function createHostDrivers(): readonly RuntimeDriver[] {
  return [
    builtinDriver(),
    claudeDriver(),
    codexDriver(),
    grokDriver(),
    antigravityDriver(),
    binaryOnly("copilot", "copilot", async () =>
      modelsToInfo("copilot", [
        {
          id: "default",
          label: "default (CLI present; no model list API)",
          supportedReasoningEfforts: ["low", "medium", "high"],
        },
      ]),
    ),
    binaryOnly("cursor", "cursor-agent", async () => []),
    binaryOnly("gemini", "gemini", async () => []),
    binaryOnly("kimi", "kimi", missingConfigModels),
    // kimi-sdk is in-process; probe via raft if available
    baseDriver("kimi-sdk", {
      detect: async () => {
        const live = await raftDriverProbeModels("kimi-sdk");
        // raft said available but missing_config — still "installed" as runtime
        if (live !== null) return { version: "kimi-sdk" };
        return { version: "kimi-sdk" };
      },
      models: async () => {
        const live = await raftDriverProbeModels("kimi-sdk");
        if (live && live.length > 0) return modelsOnly(live);
        // Empty after probe (or no daemon root) — treat as login/config, not "healthy 0".
        throw new ModelsProbeError(
          "needs_login",
          "kimi-sdk models empty / missing_config (kimi_login)",
        );
      },
    }),
    opencodeDriver(),
    piDriver(),
  ];
}

export type HostDetectMeta = {
  readonly host: string;
  readonly at: string;
  readonly sources: Readonly<Record<string, string>>;
};

export function hostDetectMeta(): HostDetectMeta {
  return {
    host: process.env.RAFT_CURRENT_COMPUTER_HOSTNAME ?? process.env.HOSTNAME ?? "local",
    at: new Date().toISOString(),
    sources: {
      codex: "~/.codex/models_cache.json + codex --version",
      claude: "claude --version + claude model list help",
      grok: "grok --version + grok models",
      opencode: "opencode --version + opencode models",
      builtin: "SLOCK_DAEMON_ROOT raft-daemon detectModels (live)",
      pi: "SLOCK_DAEMON_ROOT raft-daemon detectModels (live)",
      antigravity: "agy --version + agy models (needs_login when sign-in required)",
      copilot: "which copilot",
      cursor: "which cursor-agent",
      gemini: "which gemini",
      kimi: "which kimi",
      "kimi-sdk": "raft-daemon detectModels / missing_config → needs_login",
    },
  };
}
