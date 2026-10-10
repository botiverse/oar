/**
 * Read-only daily version inventory. No installs, credential reads or model calls.
 * Run: pnpm tsx experiments/runtime-versions.ts > versions.json
 *
 * Compare with the last probe report, then run live-contract.ts for changed
 * versions; for a changed Cursor SDK, also cursor-login/probe.ts (no
 * account needed). For a changed Grok binary, also grok-prompt-options.ts
 * (local provider, no login): recheck native prompt precedence and resume
 * rules so an upstream fix can retire the conditional refusal.
 * Tool selection: rerun sea-trial/vendor/disallowed-tools*.vendor.test.ts
 * on changed supporting runtimes; Cursor also needs cursor-disallowed-tools.ts
 * (real login and tokens). Revisit refused native channels in the tool-denial audit.
 * A version match is not a compatibility result. Pi, Pi Durable and Cursor are
 * the SDKs loaded by OAR, never an executable of the same name on the host's
 * PATH. Pi Durable's host-owned Harness is not opened by this inventory; check
 * its companion Chord SDK when upgrading and run the pi-durable-aimock backend.
 * OpenCode has separate v1/v2 release sources. Compare only the selected
 * executable's own line; an unselected line is not an outdated installation.
 * A changed OpenCode binary also needs opencode-release-lines.ts; v1 additionally
 * needs opencode-prompt-options.ts to recheck native configuration and agents.
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
