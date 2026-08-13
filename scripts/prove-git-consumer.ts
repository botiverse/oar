/**
 * Fresh-temp consumer receipt: install exact git (or file:) package and
 * ESM-import the host API. Run after the commit is local (file:) or pushed (git:).
 *
 *   OAR_CONSUMER_SPEC=file:/path/to/pkg.tgz pnpm run prove:git-consumer
 *   OAR_CONSUMER_SPEC=github:botiverse/oar#<sha> pnpm run prove:git-consumer
 *
 * Default: pack this workspace and install the tarball into a temp dir.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function sh(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, npm_config_yes: "true" },
  });
}

function main(): void {
  // Ensure built
  sh("pnpm", ["run", "build"], root);

  let spec = process.env.OAR_CONSUMER_SPEC;
  let packedTgz: string | undefined;
  if (!spec) {
    const packOut = sh("pnpm", ["pack"], root).trim();
    // pnpm pack prints the tarball name on the last line
    const lines = packOut.split("\n").map((l) => l.trim()).filter(Boolean);
    const tgzName = lines[lines.length - 1]!;
    packedTgz = join(root, tgzName);
    if (!existsSync(packedTgz)) {
      throw new Error(`pnpm pack did not produce ${packedTgz}\n${packOut}`);
    }
    spec = `file:${packedTgz}`;
  }

  const commit =
    process.env.OAR_COMMIT_SHA ??
    sh("git", ["rev-parse", "HEAD"], root).trim();

  const dir = mkdtempSync(join(tmpdir(), "oar-consumer-"));
  console.log(`consumer dir: ${dir}`);
  console.log(`install spec: ${spec}`);
  console.log(`commit: ${commit}`);

  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        {
          name: "oar-temp-consumer",
          private: true,
          type: "module",
          dependencies: {
            "@botiverse/oar": spec,
          },
        },
        null,
        2,
      ),
    );

    // Use npm install so we don't need pnpm in the consumer (minimal).
    sh("npm", ["install", "--no-fund", "--no-audit"], dir);

    const probe = `
import { createHash } from "node:crypto";
import {
  detectAll,
  detectInstallRegistered,
  createHostDrivers,
  collectUsage,
  ACCOUNT_USAGE_PROTOCOL_VERSION,
  USAGE_PROVIDERS,
  STANDALONE_COLLECTOR_VERSION,
  RAFT_DRIVER_REGISTRY,
} from "@botiverse/oar";

const required = [
  detectAll, detectInstallRegistered, createHostDrivers, collectUsage,
  ACCOUNT_USAGE_PROTOCOL_VERSION, USAGE_PROVIDERS,
  STANDALONE_COLLECTOR_VERSION, RAFT_DRIVER_REGISTRY,
];
for (const x of required) {
  if (x === undefined) throw new Error("missing export");
}

const empty = await detectAll([]);
if (!Array.isArray(empty) || empty.length !== 0) throw new Error("detectAll([]) shape");
const install = await detectInstallRegistered([], ["grok"]);
if (install[0]?.state !== "not_installed") throw new Error("install-only missing driver");
if (install[0]?.evidence.resolution !== "none") throw new Error("install-only resolution");

const drivers = createHostDrivers();
if (!Array.isArray(drivers) || drivers.length === 0) throw new Error("createHostDrivers empty");
if (!drivers.every((d) => typeof d.id === "string" && typeof d.detect === "function")) {
  throw new Error("driver shape");
}

const slot = "consumer-slot-proof";
const version = "daemon-from-consumer-1.2.3";
const observedAtMs = 1_700_000_123_000;
const snap = await collectUsage("grok", {
  localAccountSlot: slot,
  collectorVersion: version,
  observedAtMs,
});
if (snap.protocolVersion !== ACCOUNT_USAGE_PROTOCOL_VERSION) throw new Error("protocol");
if (snap.collectorVersion !== version) throw new Error("collectorVersion not injected: " + snap.collectorVersion);
if (snap.collectedAt !== new Date(observedAtMs).toISOString()) throw new Error("observedAt");
const wantKey = createHash("sha256").update("grok\\0" + slot).digest("hex");
if (snap.accounts[0]?.accountKey !== wantKey) throw new Error("accountKey slot");

if (STANDALONE_COLLECTOR_VERSION !== "oar-0.0.0") throw new Error("standalone default");
if (!Array.isArray(USAGE_PROVIDERS) || !USAGE_PROVIDERS.includes("grok")) throw new Error("USAGE_PROVIDERS");
if (!Array.isArray(RAFT_DRIVER_REGISTRY) || RAFT_DRIVER_REGISTRY.length === 0) {
  throw new Error("RAFT_DRIVER_REGISTRY");
}

console.log(JSON.stringify({
  ok: true,
  driverCount: drivers.length,
  registryCount: RAFT_DRIVER_REGISTRY.length,
  grokCollectorVersion: snap.collectorVersion,
  grokAccountKey: snap.accounts[0]?.accountKey,
  protocolVersion: snap.protocolVersion,
}, null, 2));
`;
    writeFileSync(join(dir, "probe.mjs"), probe);
    const out = sh("node", ["probe.mjs"], dir);
    console.log(out);

    // Must execute the installed bin via its shebang — not `node dist/cli.js`.
    const oarBin = join(dir, "node_modules", ".bin", "oar");
    if (!existsSync(oarBin)) {
      throw new Error(`missing ${oarBin} after npm install`);
    }
    const help = sh(oarBin, ["--help"], dir);
    if (!/Usage:\s+oar/i.test(help)) {
      throw new Error(`oar --help did not look like commander usage:\n${help}`);
    }
    console.log("oar --help (installed bin) OK");

    const installedPkg = JSON.parse(
      readFileSync(join(dir, "node_modules", "@botiverse", "oar", "package.json"), "utf8"),
    ) as { version: string };
    const printedVersion = sh(oarBin, ["--version"], dir).trim();
    if (printedVersion !== installedPkg.version) {
      throw new Error(
        `oar --version ${JSON.stringify(printedVersion)} !== package.json.version ${installedPkg.version}`,
      );
    }
    console.log(`oar --version === ${installedPkg.version} OK`);

    console.log("RECEIPT_OK");
    console.log(
      JSON.stringify(
        {
          commit,
          installSpec: spec,
          consumerDir: dir,
          packageName: "@botiverse/oar",
        },
        null,
        2,
      ),
    );
  } finally {
    // Keep dir if OAR_KEEP_CONSUMER=1 for debugging
    if (process.env.OAR_KEEP_CONSUMER !== "1") {
      rmSync(dir, { recursive: true, force: true });
    }
    if (packedTgz && process.env.OAR_KEEP_TGZ !== "1") {
      try {
        rmSync(packedTgz, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

main();
