/**
 * Kimi host runtimes — two DISTINCT identities (Huaihuai 2026-08-13, P2 parity).
 *
 *   `kimi`      canonical, means SDK **and only SDK**. SDK unresolvable ⇒ absent.
 *   `kimi-cli`  legacy descriptor, decided purely by CLI presence/version.
 *
 * Why they had to be split: `detect()` returning null is the ONLY way this
 * codebase expresses "absent" (see detect.ts — detectAll drops it,
 * detectAllRegistered marks not_installed). The previous single `kimi` driver
 * fell back SDK → $KIMI_CODE_HOME/bin/kimi → PATH kimi → {version:"unknown"},
 * so it could never return null: a host with ONLY the CLI installed produced a
 * `kimi` descriptor byte-identical to a host with the SDK. Downstream that
 * aliases two different runtimes onto one id, and the future Raft adapter
 * mapping (`kimi → kimi-sdk`, `kimi-cli → kimi`) would silently send CLI-only
 * hosts down the SDK path.
 *
 * Version (same rule as pi): real package/product semver in the version slot,
 * never a mode label. Canonical `kimi` reads the SDK package.json only;
 * `kimi-cli` reads the binary's `--version` only.
 *
 * Models: BOTH read `<KIMI_CODE_HOME|~/.kimi-code>/config.toml` → `[models.<id>]`.
 * That is deliberate parity, not a shortcut — raft-daemon's legacy CLI `kimi`
 * driver parses the same file, so making kimi-cli report an empty catalog would
 * regress the descriptor the adapter maps onto raft `kimi`. Identity is what
 * separates these two runtimes; the model catalog is a property of the product's
 * config and is genuinely shared.
 *
 * Fixture (parser tests load the same file):
 *   fixtures/kimi-config.sample.toml
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  baseDriver,
  fileExists,
  modelsToInfo,
  ModelsProbeError,
  type LiveModel,
} from "../probe.js";
import type { RuntimeDriver } from "../../../backend/trait.js";
import type { ModelInfo } from "../../../config/model.js";
import { kimiCodeHome } from "../paths.js";
import {
  resolveKimiCliVersion,
  resolveKimiSdkVersion,
} from "../kimiResolve.js";

export {
  KIMI_SDK_CANDIDATES,
  resolveKimiCliVersion,
  resolveKimiSdkVersion,
} from "../kimiResolve.js";

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

/**
 * Injectable probes. Production passes nothing; the four-state matrix tests
 * pass fakes so SDK-only / CLI-only / both / neither can be asserted without
 * touching the real PATH, filesystem, or spawning anything.
 */
export interface KimiProbes {
  readonly sdkVersion: () => string | null;
  readonly cliVersion: () => string | null;
  readonly readModels: () => readonly ModelInfo[];
}

/** Shared config.toml catalog read — identical for both identities by design. */
function readKimiModels(): readonly LiveModel[] {
  const configPath = join(kimiCodeHome(), "config.toml");
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
  return models;
}

/**
 * Canonical `kimi` — SDK ONLY.
 * ⛔ Do not add a CLI fallback here. That fallback is the exact defect this
 * split removed: it makes a CLI-only host indistinguishable from an SDK host.
 */
export function kimiDriver(probes?: Partial<KimiProbes>): RuntimeDriver {
  const sdkVersion = probes?.sdkVersion ?? resolveKimiSdkVersion;
  const models = probes?.readModels;
  return baseDriver("kimi", {
    detect: async () => {
      const version = sdkVersion();
      return version === null ? null : { version };
    },
    models: async () =>
      models ? models() : modelsToInfo("kimi", readKimiModels()),
  });
}

/**
 * Legacy `kimi-cli` — CLI presence/version ONLY.
 * ⛔ Do not consult the SDK package here, for the mirror-image reason.
 */
export function kimiCliDriver(probes?: Partial<KimiProbes>): RuntimeDriver {
  const cliVersion = probes?.cliVersion ?? resolveKimiCliVersion;
  const models = probes?.readModels;
  return baseDriver("kimi-cli", {
    detect: async () => {
      const version = cliVersion();
      return version === null ? null : { version };
    },
    models: async () =>
      models ? models() : modelsToInfo("kimi-cli", readKimiModels()),
  });
}
