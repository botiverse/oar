/**
 * Mutation tooth: required library surface for Raft host adapters.
 *
 * PASS only if:
 * 1) src/index.ts re-exports each required symbol (source mutation fails here)
 * 2) built dist/index.js actually exports them (build/pack regression fails here)
 *
 * Run: pnpm run teeth:library-exports
 * Requires: pnpm run build first (or prepare).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Host-facing API that must stay importable as `@botiverse/oar`. */
const REQUIRED_VALUE_EXPORTS = [
  "detectAll",
  "detectAllRegistered",
  "createHostDrivers",
  "hostDetectMeta",
  "collectUsage",
  "collectUsageAll",
  "parseUsageProvider",
  "USAGE_PROVIDERS",
  "ACCOUNT_USAGE_PROTOCOL_VERSION",
  "STANDALONE_COLLECTOR_VERSION",
  "unsupportedUsageSnapshot",
  "RAFT_DRIVER_REGISTRY",
  "detectInstallRegistered",
  "detectInstallOne",
  "GROK_STDIO_PROBE_ARGS",
  "MIN_SUPPORTED_OPENCODE_VERSION",
] as const;

const REQUIRED_TYPE_EXPORT_MARKERS = [
  // Type-only re-exports appear as `export type { X }` in src/index.ts
  "CollectUsageOptions",
  "AccountUsageSnapshot",
  "RuntimeDescriptor",
  "RuntimeDriver",
  "InstallDescriptor",
  "InstallState",
  "InstallEvidence",
] as const;

let failed = 0;
function ok(name: string) {
  console.log(`  PASS  ${name}`);
}
function bad(name: string, detail: string) {
  failed++;
  console.error(`  FAIL  ${name}: ${detail}`);
}

const NODE_SHEBANG = "#!/usr/bin/env node";

function hasNodeShebang(text: string): boolean {
  return text.startsWith(`${NODE_SHEBANG}\n`) || text.startsWith(`${NODE_SHEBANG}\r\n`);
}

/** Packaging tooth: npm bin.oar must remain a node shebang script. */
function assertCliShebang(): void {
  const srcCli = join(root, "src/cli.ts");
  const distCli = join(root, "dist/cli.js");
  const src = readFileSync(srcCli, "utf8");
  if (!hasNodeShebang(src)) {
    bad("src/cli.ts shebang", `first line must be ${NODE_SHEBANG}`);
  } else {
    ok("src/cli.ts shebang");
  }
  if (!existsSync(distCli)) {
    bad("dist/cli.js shebang", "missing — run pnpm run build first");
    return;
  }
  const dist = readFileSync(distCli, "utf8");
  if (!hasNodeShebang(dist)) {
    bad("dist/cli.js shebang", `tsc must preserve ${NODE_SHEBANG} as first line`);
  } else {
    ok("dist/cli.js shebang");
  }
}

/** `.bin/oar` is a symlink whose basename is `oar`, not `cli.js`. */
async function assertBinSymlinkInvokesCli(): Promise<void> {
  const distCli = join(root, "dist/cli.js");
  if (!existsSync(distCli)) {
    bad("bin symlink invoke", "missing dist/cli.js");
    return;
  }
  const src = readFileSync(join(root, "src/cli.ts"), "utf8");
  if (!/export function isCliEntry/.test(src) || !/realpathSync/.test(src)) {
    bad("isCliEntry uses realpathSync", "basename-only check misses npm bin symlink named oar");
  } else {
    ok("isCliEntry uses realpathSync");
  }
  const cliMod = (await import(pathToFileURL(distCli).href)) as {
    isCliEntry?: (argv1: string | undefined, moduleUrl: string) => boolean;
  };
  if (typeof cliMod.isCliEntry !== "function") {
    bad("isCliEntry export", "dist/cli.js must export isCliEntry");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "oar-bin-tooth-"));
  try {
    const link = join(dir, "oar");
    symlinkSync(realpathSync(distCli), link);
    const moduleUrl = pathToFileURL(realpathSync(distCli)).href;
    if (!cliMod.isCliEntry(link, moduleUrl)) {
      bad("isCliEntry(symlink named oar)", "must resolve .bin/oar → dist/cli.js");
    } else {
      ok("isCliEntry(symlink named oar)");
    }
    if (cliMod.isCliEntry(undefined, moduleUrl)) {
      bad("isCliEntry(undefined)", "must be false");
    } else {
      ok("isCliEntry(undefined) is false");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Host SDKs oar probes at runtime. Must be optional peers so a published
 * package can see the consumer's install (pnpm strict) without bundling them.
 */
const REQUIRED_OPTIONAL_PEERS = [
  "@botiverse/kimi-code-sdk",
  "@earendil-works/pi-coding-agent",
  "@mariozechner/pi-coding-agent",
] as const;

function assertCliVersionFromPackage(): void {
  const src = readFileSync(join(root, "src/cli.ts"), "utf8");
  if (/\.version\(\s*["']0\.0\.0["']\s*\)/.test(src)) {
    bad("cli version hardcode", 'buildProgram().version("0.0.0") must not exist — read package.json');
  } else {
    ok("cli version not hardcoded 0.0.0");
  }
  if (!/readPackageVersion/.test(src) || !/package\.json/.test(src)) {
    bad("cli version source", "must read version from package.json");
  } else {
    ok("cli version reads package.json");
  }
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
  const distCli = join(root, "dist/cli.js");
  if (!existsSync(distCli)) {
    bad("cli --version", "missing dist/cli.js");
    return;
  }
  const printed = execFileSync(process.execPath, [distCli, "--version"], {
    encoding: "utf8",
    cwd: root,
  }).trim();
  if (printed !== pkg.version) {
    bad("cli --version", `printed ${JSON.stringify(printed)}, package.json.version=${pkg.version}`);
  } else {
    ok(`cli --version === ${pkg.version}`);
  }
}

function assertInstallParitySource(): void {
  const src = readFileSync(join(root, "src/discovery/installDetect.ts"), "utf8");
  if (!src.includes('["agent", "stdio", "--help"]')) {
    bad("Grok stdio probe args", 'must keep ["agent", "stdio", "--help"]');
  } else {
    ok("Grok stdio probe args");
  }
  if (!src.includes('GROK_STDIO_TIMEOUT_MS = 5_000')) {
    bad("Grok stdio timeout", "must stay 5_000");
  } else {
    ok("Grok stdio timeout 5s");
  }
  if (!src.includes('MIN_SUPPORTED_OPENCODE_VERSION = "1.14.30"')) {
    bad("OpenCode min version", 'must stay "1.14.30"');
  } else {
    ok("OpenCode min 1.14.30");
  }
  if (!/from ["']\.\/host\/windowsResolve\.js["']/.test(src) || !src.includes("resolveCommandOnPath")) {
    bad("Windows resolver wired", "installDetect default path must import resolveCommandOnPath");
  } else {
    ok("Windows resolver imported by installDetect");
  }
  if (/from ["']\.\/cli\.js["']/.test(src) && /which/.test(src.match(/from ["']\.\/cli\.js["']/)?.[0] ?? "")) {
    bad("old which import", "default install path must not import which from cli.js");
  }
  if (/\bimport\s*\{[^}]*\bwhich\b[^}]*\}\s*from\s*["']\.\/cli\.js["']/.test(src)) {
    bad("old which import", "default install path must not import which from cli.js");
  } else {
    ok("installDetect does not import which");
  }
  if (/probeErrorObserved:\s*false\s*,\s*\n\s*resolution:/.test(src) && src.includes("driver.detect().then")) {
    bad("unconditional false evidence", "must not map successful detect() to probeErrorObserved:false");
  } else {
    ok("no unconditional probeErrorObserved:false on detect()");
  }
}

function assertOptionalPeers(): void {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };
  const peers = pkg.peerDependencies ?? {};
  const meta = pkg.peerDependenciesMeta ?? {};
  for (const name of REQUIRED_OPTIONAL_PEERS) {
    if (!(name in peers)) {
      bad(`peerDependencies ${name}`, "missing — published oar cannot see host SDK");
    } else {
      ok(`peerDependencies ${name}`);
    }
    if (meta[name]?.optional !== true) {
      bad(`peerDependenciesMeta ${name}.optional`, "must be true (SDK is detect-time, not required)");
    } else {
      ok(`peerDependenciesMeta ${name}.optional`);
    }
  }
}

function assertSourceReexports(): void {
  const indexPath = join(root, "src/index.ts");
  const src = readFileSync(indexPath, "utf8");
  for (const name of REQUIRED_VALUE_EXPORTS) {
    // Accept: export { … name … } from "…"  or  export { name }
    const re = new RegExp(
      String.raw`export\s*\{[^}]*\b${name}\b[^}]*\}\s*from\s*["']`,
      "m",
    );
    if (!re.test(src)) {
      bad(`src re-export ${name}`, `missing export { ${name} } from … in src/index.ts`);
    } else {
      ok(`src re-export ${name}`);
    }
  }
  for (const name of REQUIRED_TYPE_EXPORT_MARKERS) {
    const re = new RegExp(
      String.raw`export\s+type\s*\{[^}]*\b${name}\b[^}]*\}\s*from\s*["']`,
      "m",
    );
    if (!re.test(src)) {
      bad(`src type export ${name}`, `missing export type { ${name} } from … in src/index.ts`);
    } else {
      ok(`src type export ${name}`);
    }
  }
}

async function assertBuiltExports(): Promise<void> {
  const distIndex = join(root, "dist/index.js");
  if (!existsSync(distIndex)) {
    bad("dist/index.js", "missing — run pnpm run build first");
    return;
  }
  const mod = (await import(pathToFileURL(distIndex).href)) as Record<string, unknown>;
  for (const name of REQUIRED_VALUE_EXPORTS) {
    if (!(name in mod) || mod[name] === undefined) {
      bad(`dist export ${name}`, "undefined on built package entry");
    } else {
      ok(`dist export ${name}`);
    }
  }

  // Shape tooth: inject collectorVersion + slot + observedAt must stick on grok
  // (pure-local path, no CLI). Mutation removing option forwarding fails here.
  const collectUsage = mod.collectUsage as (
    provider: string,
    opts?: {
      localAccountSlot?: string;
      collectorVersion?: string;
      observedAtMs?: number;
    },
  ) => Promise<{
    collectorVersion: string;
    collectedAt: string;
    accounts: readonly { accountKey: string }[];
  }>;

  const slot = "daemon-slot-tooth";
  const version = "raft-daemon-tooth-9.9.9";
  const observedAtMs = 1_700_000_000_000;
  const snap = await collectUsage("grok", {
    localAccountSlot: slot,
    collectorVersion: version,
    observedAtMs,
  });
  if (snap.collectorVersion !== version) {
    bad(
      "collectUsage injects collectorVersion",
      `expected ${version}, got ${snap.collectorVersion}`,
    );
  } else {
    ok("collectUsage injects collectorVersion");
  }
  if (snap.collectedAt !== new Date(observedAtMs).toISOString()) {
    bad(
      "collectUsage injects observedAtMs",
      `expected ${new Date(observedAtMs).toISOString()}, got ${snap.collectedAt}`,
    );
  } else {
    ok("collectUsage injects observedAtMs");
  }
  const expectedKey = createHash("sha256").update(`grok\0${slot}`).digest("hex");
  const gotKey = snap.accounts[0]?.accountKey;
  if (gotKey !== expectedKey) {
    bad("collectUsage injects localAccountSlot into accountKey", `expected ${expectedKey}, got ${gotKey}`);
  } else {
    ok("collectUsage injects localAccountSlot into accountKey");
  }

  // detectAll + createHostDrivers are callable (may be slow if live; use empty drivers)
  const detectAll = mod.detectAll as (drivers: readonly unknown[]) => Promise<readonly unknown[]>;
  const empty = await detectAll([]);
  if (!Array.isArray(empty) || empty.length !== 0) {
    bad("detectAll([])", "expected empty array");
  } else {
    ok("detectAll([])");
  }

  const createHostDrivers = mod.createHostDrivers as () => readonly { id: string }[];
  const drivers = createHostDrivers();
  if (!Array.isArray(drivers) || drivers.length === 0) {
    bad("createHostDrivers()", "expected non-empty driver registry");
  } else {
    ok(`createHostDrivers() → ${drivers.length} drivers`);
  }
}

async function main(): Promise<void> {
  console.log("library-exports tooth");
  assertCliShebang();
  await assertBinSymlinkInvokesCli();
  assertCliVersionFromPackage();
  assertInstallParitySource();
  assertOptionalPeers();
  assertSourceReexports();
  await assertBuiltExports();
  if (failed > 0) {
    console.error(`\n${failed} failure(s)`);
    process.exit(1);
  }
  console.log("\nall library-export teeth green");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
