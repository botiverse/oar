/**
 * Shared host-probe helpers used by per-runtime drivers.
 * Change reason: version/binary/login heuristics should not live inside any one runtime file.
 * SDK runtimes call their packages in-process; CLI runtimes use binary/cache paths.
 */
import type { RuntimeDriver } from "../../backend/runtimeDriver.js";
import type { ModelInfo, ProviderInfo } from "../../config/model.js";
import { subprocessDriver } from "../../backend/subprocessDriver.js";
import { fileExists, firstLineVersion, home, runText, which } from "../cli.js";
import { ModelsProbeError } from "../detect.js";
import { modelsOnly, modelsToInfo, type LiveModel } from "./modelMapping.js";

export type { LiveModel };
export { ModelsProbeError, modelsOnly, modelsToInfo, fileExists, home, runText, which, firstLineVersion };

/** CLI stderr/stdout that means "binary is there; auth is not". */
export function looksLikeNeedsLogin(text: string): boolean {
  return /please sign in|sign in to view|not (logged|signed) in|login required|authentication required|missing_config|kimi_login|auth required/i.test(
    text,
  );
}

/**
 * A discovery-only driver: detect + models(+providers) with the default
 * subprocess launch (bare `<id>`, `process_spawned` readiness, `() => []`
 * normalise). These runtimes are DETECTED but not yet driven for real — the
 * weak defaults are the honest declaration of that. A runtime that becomes
 * drivable supplies plan/readiness/handshake/normalise to `subprocessDriver`
 * directly (see codex).
 */
export function baseDriver(
  id: string,
  impl: {
    detect: () => Promise<{ version: string } | null>;
    models: () => Promise<readonly ModelInfo[]>;
    providers?: () => Promise<readonly ProviderInfo[]>;
  },
): RuntimeDriver {
  return subprocessDriver({
    id,
    detect: impl.detect,
    models: impl.models,
    ...(impl.providers ? { providers: impl.providers } : {}),
  });
}

export function versionVia(
  bin: string,
  args: string[] = ["--version"],
): Promise<{ version: string } | null> {
  return Promise.resolve().then(() => {
    const path = which(bin);
    if (!path) return null;
    const r = runText(path, args, { timeoutMs: 10_000 });
    const v = firstLineVersion(r.stdout) ?? firstLineVersion(r.stderr);
    if (!v) return { version: path };
    return { version: v };
  });
}

export function binaryOnly(
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


