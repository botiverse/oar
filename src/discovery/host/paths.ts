/**
 * Runtime home / state-root resolution — single source shared by both the
 * model-detect drivers and the usage collectors.
 *
 * Rationale (xxchan / Huaihuai 2026-08-10 refactor): the same runtime home was
 * being resolved in more than one place with subtly different logic (kimi home
 * was written twice: `resolveKimiCodeHome()` in the detect driver and
 * `kimiHome()` in the usage collector). Home/state-root resolution lives here
 * once; detect and usage import it, so the two can never drift.
 *
 * ⛔ Binary/candidate spawn arbitration (CODEX_BIN fail-closed, Desktop/npm
 *    candidates, app-server version arbitration — see raft
 *    `packages/daemon/src/drivers/codex.ts`) is a separate concern and will land
 *    in a per-runtime `*Resolve.ts`; this file is home/config-root only.
 */
import path from "node:path";
import { home } from "../cli.js";

/**
 * Kimi SDK/product home: `$KIMI_CODE_HOME` or `~/.kimi-code`.
 * Single source for both `detect` (config.toml, bin/kimi) and `usage`
 * (credentials/kimi-code.json).
 */
export function kimiCodeHome(): string {
  return process.env.KIMI_CODE_HOME?.trim() || home(".kimi-code");
}

/**
 * Codex state root: `$CODEX_HOME` (resolved) or `~/.codex`.
 * (Mirrors raft `resolveCodexHomeRootFromEnv`; oar previously ignored
 * `$CODEX_HOME` and hard-coded `~/.codex`.)
 */
export function codexHome(...parts: string[]): string {
  const configured = process.env.CODEX_HOME?.trim();
  const root = configured && configured.length > 0 ? path.resolve(configured) : home(".codex");
  return parts.length > 0 ? path.join(root, ...parts) : root;
}

export { home };
