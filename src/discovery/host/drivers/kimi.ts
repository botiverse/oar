/**
 * Kimi host runtime — SDK path only (xxchan / Huaihuai 2026-08-10).
 *
 * Registry id is product name `kimi` (not raft's internal `kimi-sdk`).
 * Models: pure-read of SDK config dir (not the kimi CLI model list).
 *
 * Version (same rule as pi): real package/product semver in the version slot.
 * Prefer `@botiverse/kimi-code-sdk` package.json; else `kimi --version` from the
 * installed product binary under PATH / `$KIMI_CODE_HOME/bin`. Unresolvable →
 * `unknown` (typed empty, not a mode label).
 *
 * Models source mirrors raft-daemon `detectKimiSdkModels`:
 * `<KIMI_CODE_HOME|~/.kimi-code>/config.toml` → `[models.<id>]` + display_name.
 *
 * Fixture (parser tests load the same file):
 *   fixtures/kimi-config.sample.toml
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  baseDriver,
  fileExists,
  modelsToInfo,
  ModelsProbeError,
  versionVia,
  runText,
  firstLineVersion,
  type LiveModel,
} from "../probe.js";
import type { RuntimeDriver } from "../../../backend/trait.js";
import { kimiCodeHome } from "../paths.js";

const PKG_JSON_CANDIDATES = [
  "@botiverse/kimi-code-sdk/package.json",
  "@moonshot-ai/kimi-code-sdk/package.json",
] as const;

/** Read installed kimi SDK / product version — never invent a mode string. */
export function resolveKimiSdkVersion(): string | null {
  try {
    const require = createRequire(import.meta.url);
    for (const spec of PKG_JSON_CANDIDATES) {
      try {
        const p = require.resolve(spec);
        const v = (JSON.parse(readFileSync(p, "utf8")) as { version?: string }).version;
        if (typeof v === "string" && v.length > 0) return v;
      } catch {
        // next
      }
    }
  } catch {
    // fall through
  }

  // Walk node_modules next to the oar process and common global prefixes.
  const searchRoots = [
    process.cwd(),
    dirname(process.execPath),
    join(dirname(process.execPath), "..", "lib", "node_modules"),
  ];
  for (const root of searchRoots) {
    for (const rel of [
      "node_modules/@botiverse/kimi-code-sdk/package.json",
      "node_modules/@moonshot-ai/kimi-code-sdk/package.json",
    ]) {
      const p = join(root, rel);
      if (!existsSync(p)) continue;
      try {
        const v = (JSON.parse(readFileSync(p, "utf8")) as { version?: string }).version;
        if (typeof v === "string" && v.length > 0) return v;
      } catch {
        // next
      }
    }
  }

  return null;
}

/** Pure parse of kimi-code config.toml — unit-tested without the filesystem. */
export function parseKimiCodeConfigToml(raw: string): {
  models: LiveModel[];
  defaultModel?: string;
} {
  const models: LiveModel[] = [];
  const sectionRe = /^\s*\[models\.(.+?)\s*\]\s*$/gm;
  let sectionMatch: RegExpExecArray | null = sectionRe.exec(raw);
  while (sectionMatch !== null) {
    let id = sectionMatch[1]!.trim();
    if (id.startsWith('"') && id.endsWith('"')) id = id.slice(1, -1);
    if (!id) {
      sectionMatch = sectionRe.exec(raw);
      continue;
    }

    const sectionStart = sectionMatch.index + sectionMatch[0].length;
    const nextSection = raw.slice(sectionStart).search(/^\s*\[/m);
    const body =
      nextSection === -1
        ? raw.slice(sectionStart)
        : raw.slice(sectionStart, sectionStart + nextSection);
    const displayMatch = body.match(/^\s*display_name\s*=\s*"([^"]+)"/m);
    const label = displayMatch ? displayMatch[1]! : id;

    const effortsMatch = body.match(/^\s*support_efforts\s*=\s*\[([^\]]*)\]/m);
    const supportedReasoningEfforts: string[] | undefined = effortsMatch
      ? [...effortsMatch[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!)
      : undefined;

    const entry: LiveModel = { id, label };
    if (supportedReasoningEfforts && supportedReasoningEfforts.length > 0) {
      entry.supportedReasoningEfforts = supportedReasoningEfforts;
    }
    models.push(entry);
    sectionMatch = sectionRe.exec(raw);
  }

  const defaultMatch = raw.match(/^\s*default_model\s*=\s*"([^"]+)"/m);
  const defaultModel: string | undefined = defaultMatch ? defaultMatch[1] : undefined;

  return { models, ...(defaultModel !== undefined ? { defaultModel } : {}) };
}

export function kimiDriver(): RuntimeDriver {
  return baseDriver("kimi", {
    // In-process capability is always a host fact (config may still be missing).
    // Version: package first; else product binary --version; else typed unknown.
    detect: async () => {
      const fromPkg = resolveKimiSdkVersion();
      if (fromPkg) return { version: fromPkg };
      // Product binary version (PATH or $KIMI_CODE_HOME/bin) — not used for models.
      const homeBin = join(kimiCodeHome(), "bin", "kimi");
      if (fileExists(homeBin)) {
        const r = runText(homeBin, ["--version"], { timeoutMs: 10_000 });
        const v = firstLineVersion(r.stdout) ?? firstLineVersion(r.stderr);
        if (v) return { version: v };
      }
      const fromCli = await versionVia("kimi");
      if (fromCli?.version) return fromCli;
      return { version: "unknown" };
    },
    models: async () => {
      const kimiHome = kimiCodeHome();
      const configPath = join(kimiHome, "config.toml");
      if (!fileExists(configPath)) {
        throw new ModelsProbeError(
          "needs_login",
          "kimi config.toml missing (run kimi login / set KIMI_CODE_HOME)",
        );
      }
      let raw = "";
      try {
        raw = readFileSync(configPath, "utf8");
      } catch {
        throw new ModelsProbeError("models_unavailable", "kimi config.toml unreadable");
      }
      const { models } = parseKimiCodeConfigToml(raw);
      if (models.length === 0) {
        throw new ModelsProbeError(
          "needs_login",
          "kimi config.toml has no [models.*] sections",
        );
      }
      return modelsToInfo("kimi", models);
    },
  });
}
