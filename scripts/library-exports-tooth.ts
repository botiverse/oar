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
import { readFileSync, existsSync } from "node:fs";
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
] as const;

const REQUIRED_TYPE_EXPORT_MARKERS = [
  // Type-only re-exports appear as `export type { X }` in src/index.ts
  "CollectUsageOptions",
  "AccountUsageSnapshot",
  "RuntimeDescriptor",
  "RuntimeDriver",
] as const;

let failed = 0;
function ok(name: string) {
  console.log(`  PASS  ${name}`);
}
function bad(name: string, detail: string) {
  failed++;
  console.error(`  FAIL  ${name}: ${detail}`);
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
