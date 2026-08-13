/**
 * Strict fresh-consumer tooth for SDK visibility (task #5, Huaihuai 2026-08-13).
 *
 * Proves the thing no unit test can: that a PUBLISHED OAR, installed beside the
 * real SDKs under a strict node_modules layout, resolves their real versions
 * from its own module position.
 *
 *   consumer deps = packed @botiverse/oar  +  real @botiverse/kimi-code-sdk
 *                                          +  real @earendil-works/pi-coding-agent
 *   assertion     = detectAllRegistered() reports those exact versions,
 *                   and neither runtime is `not_installed`
 *
 * ⚠️ The consumer installs with **pnpm**, not npm, and that is load-bearing.
 * npm hoists every transitive package to the top level, so OAR would resolve an
 * SDK it never declared — which would make the "remove the optional peer -> RED"
 * half of this tooth silently unfalsifiable. pnpm's isolated layout is what makes
 * peer declaration actually necessary, and therefore testable.
 *
 * Two mutations must turn this RED (see MUTATIONS.md notes in the delivery):
 *   1. remove `@botiverse/kimi-code-sdk` from OAR's optional peerDependencies
 *   2. restore the `<pkg>/package.json` subpath in the resolver
 *
 * Run:  pnpm run teeth:strict-sdk-consumer
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Versions are read from the consumer's own install, never hardcoded here — a
 *  pinned literal would start lying the moment the registry moves. */
const KIMI_SDK = "@botiverse/kimi-code-sdk";
const PI_SDK = "@earendil-works/pi-coding-agent";

function sh(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, npm_config_yes: "true" },
  });
}

function fail(msg: string): never {
  console.error(`\nSTRICT CONSUMER TOOTH: RED\n${msg}\n`);
  process.exit(1);
}

function main(): void {
  sh("pnpm", ["run", "build"], root);

  const packOut = sh("pnpm", ["pack"], root).trim();
  const lines = packOut.split("\n").map((l) => l.trim()).filter(Boolean);
  const tgz = join(root, lines[lines.length - 1]!);
  if (!existsSync(tgz)) fail(`pnpm pack did not produce ${tgz}\n${packOut}`);

  // Fail early and loudly if the tarball does not declare the peers this tooth
  // is about — otherwise a packaging regression would present as an SDK bug.
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };
  for (const spec of [KIMI_SDK, PI_SDK]) {
    if (!manifest.peerDependencies?.[spec]) {
      fail(`${spec} is not declared as a peerDependency — a strict consumer cannot make it visible to OAR`);
    }
    if (manifest.peerDependenciesMeta?.[spec]?.optional !== true) {
      fail(`${spec} peer must be optional:true (OAR must still work without it)`);
    }
  }

  const dir = mkdtempSync(join(tmpdir(), "oar-strict-consumer-"));
  console.log(`consumer dir : ${dir}`);
  console.log(`oar tarball  : ${tgz}`);
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        {
          name: "oar-strict-consumer",
          private: true,
          type: "module",
          dependencies: {
            "@botiverse/oar": `file:${tgz}`,
            [KIMI_SDK]: "*",
            [PI_SDK]: "*",
          },
        },
        null,
        2,
      ),
    );
    // Isolated layout: no accidental hoisting, so visibility must come from the
    // peer declaration rather than from npm's flat node_modules.
    // strict-dep-builds=false: the SDKs pull transitive packages with install
    // scripts (protobufjs et al). pnpm 10 treats "ignored build scripts" as a
    // hard error, which has nothing to do with what this tooth measures — we do
    // not need those packages BUILT, only RESOLVABLE.
    writeFileSync(
      join(dir, ".npmrc"),
      "node-linker=isolated\nauto-install-peers=false\nstrict-dep-builds=false\n",
    );

    sh("pnpm", ["install", "--no-frozen-lockfile", "--config.strictDepBuilds=false"], dir);

    const installedKimi = JSON.parse(
      readFileSync(join(dir, "node_modules", KIMI_SDK, "package.json"), "utf8"),
    ) as { version: string };
    const installedPi = JSON.parse(
      readFileSync(join(dir, "node_modules", PI_SDK, "package.json"), "utf8"),
    ) as { version: string };
    console.log(`installed sdk: kimi=${installedKimi.version} pi=${installedPi.version}`);

    const probe = `
import { detectAllRegistered, createHostDrivers, RAFT_DRIVER_REGISTRY } from "@botiverse/oar";

const descs = await detectAllRegistered(createHostDrivers(), [...RAFT_DRIVER_REGISTRY]);
const by = new Map(descs.map((d) => [d.runtime, d]));
console.log(JSON.stringify({
  kimi: { version: by.get("kimi")?.version, failure: by.get("kimi")?.failure },
  pi: { version: by.get("pi")?.version, failure: by.get("pi")?.failure },
  kimiCli: { version: by.get("kimi-cli")?.version, failure: by.get("kimi-cli")?.failure },
}));
`;
    writeFileSync(join(dir, "probe.mjs"), probe);
    const raw = sh("node", ["probe.mjs"], dir).trim();
    const observed = JSON.parse(raw.split("\n").filter(Boolean).pop()!) as {
      kimi: { version?: string; failure?: string };
      pi: { version?: string; failure?: string };
      kimiCli: { version?: string; failure?: string };
    };
    console.log(`oar reported : ${JSON.stringify(observed)}`);

    // The assertion: OAR read the SDK version from ITS OWN module position.
    if (observed.kimi.failure === "not_installed") {
      fail(`canonical kimi reported not_installed while ${KIMI_SDK}@${installedKimi.version} is installed beside OAR`);
    }
    if (observed.kimi.version !== installedKimi.version) {
      fail(`kimi version mismatch: OAR says ${String(observed.kimi.version)}, installed is ${installedKimi.version}`);
    }
    if (observed.pi.failure === "not_installed") {
      fail(`pi reported not_installed while ${PI_SDK}@${installedPi.version} is installed beside OAR`);
    }
    if (observed.pi.version !== installedPi.version) {
      fail(`pi version mismatch: OAR says ${String(observed.pi.version)}, installed is ${installedPi.version}`);
    }
    // Identity parity still holds in the published shape: no kimi CLI here, so
    // the legacy row must be absent even though the SDK row is present.
    if (observed.kimiCli.failure !== "not_installed") {
      fail(`kimi-cli must be not_installed in a consumer with no kimi binary, got ${String(observed.kimiCli.failure)}`);
    }

    console.log("\nSTRICT CONSUMER TOOTH: GREEN");
    console.log(`  kimi ${observed.kimi.version} / pi ${observed.pi.version} resolved from OAR's own position`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(tgz, { force: true });
  }
}

main();
