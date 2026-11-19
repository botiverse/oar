import type { RuntimePlatform } from "./contracts/runtime.js";

export type { RuntimePlatform } from "./contracts/runtime.js";

const all = ["linux", "darwin", "win32"] as const satisfies readonly RuntimePlatform[];
const posix = ["linux", "darwin"] as const satisfies readonly RuntimePlatform[];

/**
 * Operating systems where a gating CI job (one a release waits for) runs
 * OAR's behavior suite against the runtime's real binary or SDK. OpenCode gates both native lines on Windows.
 * Kimi and Grok run there in the separate observation workflow. Evidence: `.github/runtime-versions.json`
 * and `.github/scripts/ci-select.mjs`; tests/verified-platforms.test.ts keeps
 * them in step. A runtime without an entry is unknown, not unsupported.
 */
export const verifiedPlatforms = {
  claude: all, codex: all, qwen: all, qoder: all, dsh: all, antigravity: all,
  pi: all, "pi-durable": all,
  kimi: posix, grok: posix, opencode: all, factory: posix, codebuddy: posix,
} as const satisfies Readonly<Record<string, readonly RuntimePlatform[]>>;
