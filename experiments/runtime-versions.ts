/**
 * Read-only daily version inventory. No installs, credential reads or model calls.
 * Run: pnpm tsx experiments/runtime-versions.ts > versions.json
 *
 * Compare with the last probe report, then run live-contract.ts for changed
 * versions. A version match is not a compatibility result. Pi is the SDK loaded
 * by OAR, never the unrelated executable named `pi` on the host's PATH.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import path from "node:path";
import { runtimes } from "../packages/oar/src/index.js";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const sources = [
  { id: "claude", url: "https://registry.npmjs.org/@anthropic-ai/claude-code/latest" },
  { id: "codex", url: "https://registry.npmjs.org/@openai/codex/latest" },
  // The stable pointer used by the official https://x.ai/cli/install.sh.
  { id: "grok", url: "https://x.ai/cli/stable" },
  { id: "kimi", url: "https://registry.npmjs.org/@moonshot-ai/kimi-code/latest" },
  { id: "pi", url: `https://registry.npmjs.org/${PI_PACKAGE}/latest` },
] as const;

function versionOf(value: string): string {
  const version = /\b\d+\.\d+\.\d+(?:-[\w.]+)?\b/u.exec(value)?.[0];
  assert.ok(version !== undefined, "version response has no semantic version");
  return version;
}

async function piVersion(): Promise<string> {
  // Resolve from the adapter, not the workspace: the two dependency ranges
  // need not resolve to the same installed SDK in a consumer's checkout.
  const adapter = new URL("../packages/oar/src/runtimes/pi/installation.ts", import.meta.url);
  const manifest = findPackageJSON(PI_PACKAGE, adapter);
  assert.ok(manifest !== undefined, "cannot locate the installed Pi SDK manifest");
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
    const installation = await runtimes.require(id).installation?.();
    let installed: string | null = null;
    if (id === "pi") {
      installed = await piVersion();
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
