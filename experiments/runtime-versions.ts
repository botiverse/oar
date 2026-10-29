/**
 * Read-only daily version inventory. No installs, credential reads or model calls.
 * Run: pnpm tsx experiments/runtime-versions.ts > versions.json
 *
 * Compare with the last probe report, then run live-contract.ts for changed
 * versions; for a changed Cursor SDK, also cursor-login/probe.ts and
 * cursor-user-configuration/probe.ts (no account needed). For a changed Claude
 * binary, also run
 * claude-login-browser/probe.ts on Linux (local OAuth stand-in, no account):
 * recheck BROWSER suppression and no fallback after a failed opener, and
 * record the result in that day's runtime-version-checks report.
 * For a changed Grok binary, also grok-prompt-options.ts
 * (local provider, no login): recheck native prompt precedence and resume
 * rules so an upstream fix can retire the conditional refusal.
 * Keep the Kimi, Grok and OpenCode v1 ACP CI package pins in ci.yml aligned
 * with verified upgrades; rerun shared and vendor suites on all three platforms.
 * Tool selection: rerun sea-trial/vendor/disallowed-tools*.vendor.test.ts
 * on changed supporting runtimes; Cursor also needs cursor-disallowed-tools.ts
 * (real login and tokens). Revisit refused native channels in the tool-denial audit.
 * A changed Antigravity server also needs antigravity-native-settings.ts:
 * recheck instruction/effort channels and native MCP credential persistence.
 * Also rerun antigravity-steering.ts. Watch agy stream-json and ACP for a
 * publicly documented immediate-send/control-request interface; notify the
 * maintainer before changing the transport or adding steering.
 * A changed Qwen binary also needs qwen-native/probe.ts and the qwen-aimock
 * vendor/behavior suites (local provider, isolated HOME, no account). Also run
 * qwen-native/lock-lifetime.ts: a successful warmup does not prove shared-HOME
 * concurrency is safe; retain initialization timing and the held-lock result.
 * Compare Qwen provider presets' envKey values and native auth-key variables
 * with runtimes/qwen/auth-status.ts KEY_NAMES; add new sources and regressions
 * so configured credentials cannot become a false logged_out result.
 * Watch Qwen issues #15796 (extension-store lock) and #15875 (thinking/text
 * snapshot ids). After a native snapshot fix, rerun the structure regressions
 * and remove the Qwen-specific snapshot rule if it is no longer needed.
 * A changed Kimi binary also needs sea-trial/vendor/kimi-login.vendor.test.ts
 * with OAR_TEST=kimi-login (local OAuth stand-in, no account). Recheck all three platforms before updating the CI login pin
 * and the minimum version accepted by loginExecutable in kimi/login.ts and
 * kimi/logout.ts; keep the native login fixture's version aligned.
 * A changed Qoder binary also needs the qoder-native vendor/behavior suites
 * and login tests (native model replay, isolated HOME, no account).
 * A version match is not a compatibility result. Pi, Pi Durable and Cursor are
 * the SDKs loaded by OAR, never an executable of the same name on the host's
 * PATH. Pi Durable's host-owned Harness is not opened by this inventory; check
 * its companion Chord SDK when upgrading and run the pi-durable-aimock backend.
 * Prioritize a Pi release newer than 1.4.0 the same day: upgrade OAR's own undici
 * together to Pi's exact pin, verify one resolved copy, then run both Pi modes
 * and Pi Durable. Do not bump undici independently.
 * Also compare deepseek-harness master with the last report: OAR patch files,
 * its workspace OAR pin/patchedDependencies and both experimental subagent-oar
 * packages. Record changed patches and their reason for maintainer review.
 * OpenCode has separate v1/v2 release sources. Compare only the selected
 * executable's own line; an unselected line is not an outdated installation.
 * A changed OpenCode binary also needs opencode-release-lines.ts; v1 additionally
 * needs opencode-prompt-options.ts to recheck native configuration and agents.
 * For v2 startup failures, opencode-startup.ts compares native cold concurrent
 * bootstrap with sequential/warm controls without OAR or model requests.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import path from "node:path";
import { allRuntimes } from "../sea-trial/harness/runtimes.js";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const PI_DURABLE_PACKAGE = "@earendil-works/pi-durable";
const CURSOR_PACKAGE = "@cursor/sdk";
const sources: readonly { id: string; url: string; major?: number }[] = [
  { id: "antigravity", url: "https://raw.githubusercontent.com/agentclientprotocol/registry/main/antigravity-acp/agent.json" },
  { id: "claude", url: "https://registry.npmjs.org/@anthropic-ai/claude-code/latest" },
  { id: "codex", url: "https://registry.npmjs.org/@openai/codex/latest" },
  { id: "cursor", url: `https://registry.npmjs.org/${CURSOR_PACKAGE}/latest` },
  // The stable pointer used by the official https://x.ai/cli/install.sh.
  { id: "grok", url: "https://x.ai/cli/stable" },
  { id: "kimi", url: "https://registry.npmjs.org/@moonshot-ai/kimi-code/latest" },
  { id: "opencode", major: 1, url: "https://registry.npmjs.org/opencode-ai/latest" },
  { id: "opencode", major: 2, url: "https://registry.npmjs.org/@opencode/cli/latest" },
  { id: "codebuddy", url: "https://registry.npmjs.org/@tencent-ai/codebuddy-code/latest" },
  { id: "qoder", url: "https://registry.npmjs.org/@qoder-ai/qodercli/latest" },
  { id: "qwen", url: "https://registry.npmjs.org/@qwen-code/qwen-code/latest" },
  { id: "pi", url: `https://registry.npmjs.org/${PI_PACKAGE}/latest` },
  { id: "pi-durable", url: `https://registry.npmjs.org/${PI_DURABLE_PACKAGE}/latest` },
];

function versionOf(value: string): string {
  // OpenCode 2 prints "opencode v2.x.y", unlike the bare v1 version.
  const version = /\bv?(?<version>\d+\.\d+\.\d+(?:-[\w.]+)?)\b/u.exec(value)?.groups?.version;
  assert.ok(version !== undefined, "version response has no recognized version");
  return version;
}

const SDKS: Readonly<Record<string, { packageName: string; from: URL }>> = {
  // Pi is loaded by the adapter; Cursor is supplied by this repo's host.
  // Resolve each from its actual importer, since their dependency versions
  // can differ from another installation of the same package in the workspace.
  pi: {
    packageName: PI_PACKAGE,
    from: new URL("../packages/oar/src/runtimes/pi/installation.ts", import.meta.url),
  },
  cursor: {
    packageName: CURSOR_PACKAGE,
    from: new URL("../sea-trial/harness/runtimes.ts", import.meta.url),
  },
  "pi-durable": {
    packageName: PI_DURABLE_PACKAGE,
    from: new URL("../sea-trial/harness/pi-durable.ts", import.meta.url),
  },
};

async function sdkVersion(sdk: { packageName: string; from: URL }): Promise<string> {
  const manifest = findPackageJSON(sdk.packageName, sdk.from);
  assert.ok(manifest !== undefined, `cannot locate the installed ${sdk.packageName} manifest`);
  const data: unknown = JSON.parse(await readFile(manifest, "utf8"));
  assert.ok(typeof data === "object" && data !== null && "version" in data && typeof data.version === "string");
  return versionOf(data.version);
}

const results = await Promise.all(sources.map(async ({ id, url, major }) => {
  const line = major === undefined ? undefined : `v${String(major)}`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    assert.ok(response.ok, `version source returned HTTP ${String(response.status)}`);
    let latest = "";
    if (id === "grok") {
      latest = versionOf(await response.text());
    } else {
      const data: unknown = await response.json();
      assert.ok(typeof data === "object" && data !== null && "version" in data && typeof data.version === "string");
      latest = versionOf(data.version);
    }
    const installation = id === "pi-durable" ? undefined : await allRuntimes.require(id).installation?.();
    let installed: string | null = null;
    const sdk = SDKS[id];
    if (sdk !== undefined) {
      installed = await sdkVersion(sdk);
    } else if (installation?.kind === "available" && installation.via === "executable" && installation.version !== undefined) {
      installed = versionOf(installation.version);
    }
    let status = "unavailable";
    if (installed !== null) {
      if (major !== undefined && installed.split(".")[0] !== String(major)) {
        status = "other_release_line";
      } else {
        status = installed === latest ? "current" : "different";
      }
    }
    return {
      runtime: id, line, source: url, latest, installed,
      installation: id === "pi-durable" ? "host_supplied" : installation?.kind ?? "unsupported",
      status,
    };
  } catch (error) {
    process.exitCode = 1;
    return { runtime: id, line, source: url, status: "error", error: error instanceof Error ? error.message : String(error) };
  }
}));

const report = {
  checkedAt: new Date().toISOString(),
  platform: `${process.platform}-${process.arch}`,
  node: process.version,
  script: path.relative(process.cwd(), import.meta.filename),
  results,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
