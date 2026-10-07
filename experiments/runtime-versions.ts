/**
 * Read-only daily version inventory. No installs, credential reads or model calls.
 * Run: pnpm tsx experiments/runtime-versions.ts > versions.json
 *
 * Compare with the last probe report, then run live-contract.ts for changed
 * versions; for a changed Cursor SDK, also cursor-login/probe.ts (no
 * account needed). For a changed Grok binary, also grok-prompt-options.ts
 * (local provider, no login): recheck native prompt precedence and resume
 * rules so an upstream fix can retire the conditional refusal.
 * A version match is not a compatibility result. Pi and Cursor are
 * the SDKs loaded by OAR, never an executable of the same name on the host's
 * PATH.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import path from "node:path";
import { allRuntimes } from "../sea-trial/harness/runtimes.js";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const CURSOR_PACKAGE = "@cursor/sdk";
const sources = [
  { id: "antigravity", url: "https://raw.githubusercontent.com/agentclientprotocol/registry/main/antigravity-acp/agent.json" },
  { id: "claude", url: "https://registry.npmjs.org/@anthropic-ai/claude-code/latest" },
  { id: "codex", url: "https://registry.npmjs.org/@openai/codex/latest" },
  { id: "cursor", url: `https://registry.npmjs.org/${CURSOR_PACKAGE}/latest` },
  // The stable pointer used by the official https://x.ai/cli/install.sh.
  { id: "grok", url: "https://x.ai/cli/stable" },
  { id: "kimi", url: "https://registry.npmjs.org/@moonshot-ai/kimi-code/latest" },
  // The npm package the install script and `opencode upgrade` track alike.
  { id: "opencode", url: "https://registry.npmjs.org/opencode-ai/latest" },
  { id: "pi", url: `https://registry.npmjs.org/${PI_PACKAGE}/latest` },
] as const;

function versionOf(value: string): string {
  const version = /\b\d+\.\d+\.\d+(?:-[\w.]+)?\b/u.exec(value)?.[0];
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
};

async function sdkVersion(sdk: { packageName: string; from: URL }): Promise<string> {
  const manifest = findPackageJSON(sdk.packageName, sdk.from);
  assert.ok(manifest !== undefined, `cannot locate the installed ${sdk.packageName} manifest`);
  const data: unknown = JSON.parse(await readFile(manifest, "utf8"));
  assert.ok(typeof data === "object" && data !== null && "version" in data && typeof data.version === "string");
  return versionOf(data.version);
}

const results = await Promise.all(sources.map(async ({ id, url }) => {
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
    const installation = await allRuntimes.require(id).installation?.();
    let installed: string | null = null;
    const sdk = SDKS[id];
    if (sdk !== undefined) {
      installed = await sdkVersion(sdk);
    } else if (installation?.kind === "available" && installation.via === "executable" && installation.version !== undefined) {
      installed = versionOf(installation.version);
    }
    let status = "unavailable";
    if (installed !== null) {
      status = installed === latest ? "current" : "different";
    }
    return {
      runtime: id, source: url, latest, installed,
      installation: installation?.kind ?? "unsupported",
      status,
    };
  } catch (error) {
    process.exitCode = 1;
    return { runtime: id, source: url, status: "error", error: error instanceof Error ? error.message : String(error) };
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
