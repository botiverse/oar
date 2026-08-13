import assert from "node:assert/strict";
import test from "node:test";
import { detectAllRegistered, type RuntimeDescriptor } from "../../detect.js";
import { model } from "../../../config/model.js";
import { kimiCliDriver, kimiDriver, type KimiProbes } from "./kimi.js";

/**
 * Identity parity for the two Kimi install identities (task #5, P2).
 *
 * The contract under test is NOT "does kimi work" — it is that `kimi` (SDK) and
 * `kimi-cli` (CLI) can never alias. Before the split, `kimi`'s detect fell back
 * through the CLI and finally to {version:"unknown"}, so it never returned null:
 * a CLI-only host and an SDK host produced the same `kimi` descriptor. The Raft
 * adapter maps `kimi → kimi-sdk` and `kimi-cli → kimi`, so that alias would
 * route CLI-only hosts down the SDK path.
 *
 * All four cells are asserted because each one fails differently:
 *   SDK-only  a CLI fallback creeping back into kimi shows up here
 *   CLI-only  an SDK fallback creeping into kimi-cli shows up here
 *   both      version cross-contamination shows up ONLY here (both are present,
 *             so presence alone cannot tell the drivers apart)
 *   neither   a driver that reports "unknown" instead of absent shows up here
 *
 * Probes are injected, so no cell touches the real PATH, filesystem, or spawns
 * a process — the matrix is about identity resolution, and a test that depended
 * on what happens to be installed on the runner could not assert a cell at all.
 */

const SDK_VERSION = "0.9.3";
const CLI_VERSION = "1.4.0-cli";

/** A non-empty catalog, present in every cell — see the models-are-not-presence test. */
const CONFIG_MODELS = [model("kimi-code/k3", "K3", [])] as const;

function probes(opts: {
  sdk: string | null;
  cli: string | null;
}): Pick<KimiProbes, "sdkVersion" | "cliVersion" | "readModels"> {
  return {
    sdkVersion: () => opts.sdk,
    cliVersion: () => opts.cli,
    readModels: () => CONFIG_MODELS,
  };
}

async function detectMatrix(opts: {
  sdk: string | null;
  cli: string | null;
}): Promise<Map<string, RuntimeDescriptor>> {
  const p = probes(opts);
  const descs = await detectAllRegistered(
    [kimiDriver(p), kimiCliDriver(p)],
    ["kimi", "kimi-cli"],
  );
  return new Map(descs.map((d) => [d.runtime, d]));
}

function assertInstalled(d: RuntimeDescriptor | undefined, version: string): void {
  assert.ok(d, "descriptor must be enumerated");
  assert.equal(d.failure, undefined, `expected installed, got failure=${String(d.failure)}`);
  assert.equal(d.version, version);
}

function assertNotInstalled(d: RuntimeDescriptor | undefined): void {
  assert.ok(d, "descriptor must still be enumerated, not omitted");
  assert.equal(d.failure, "not_installed");
  assert.equal(d.models.length, 0);
}

test("SDK-only host: kimi installed, kimi-cli not_installed", async () => {
  const m = await detectMatrix({ sdk: SDK_VERSION, cli: null });
  assertInstalled(m.get("kimi"), SDK_VERSION);
  assertNotInstalled(m.get("kimi-cli"));
});

test("CLI-only host: kimi-cli installed, canonical kimi not_installed", async () => {
  const m = await detectMatrix({ sdk: null, cli: CLI_VERSION });
  assertInstalled(m.get("kimi-cli"), CLI_VERSION);
  assertNotInstalled(m.get("kimi"));
});

test("both installed: two distinct rows, each carrying its OWN version", async () => {
  const m = await detectMatrix({ sdk: SDK_VERSION, cli: CLI_VERSION });
  assertInstalled(m.get("kimi"), SDK_VERSION);
  assertInstalled(m.get("kimi-cli"), CLI_VERSION);
  // The anti-alias assertion proper: same product, but the two descriptors must
  // not be interchangeable. If either driver ever read the other's probe, the
  // versions would collapse onto one value and this is the only cell that sees it.
  assert.notEqual(m.get("kimi")!.version, m.get("kimi-cli")!.version);
});

test("neither installed: both absent, neither degraded to version 'unknown'", async () => {
  const m = await detectMatrix({ sdk: null, cli: null });
  assertNotInstalled(m.get("kimi"));
  assertNotInstalled(m.get("kimi-cli"));
});

test("a populated config.toml does not make an uninstalled runtime installed", async () => {
  // Huaihuai's acceptance tooth (2026-08-13): on a CLI-only host the config
  // catalog is readable, and kimi-cli may report it — but the presence of model
  // config must never be read as evidence that the SDK is installed. Presence is
  // decided by the install probe alone. Asserted in both directions so neither
  // driver can start inferring installedness from the shared catalog.
  const cliOnly = await detectMatrix({ sdk: null, cli: CLI_VERSION });
  assert.equal(cliOnly.get("kimi-cli")!.models.length, CONFIG_MODELS.length);
  assertNotInstalled(cliOnly.get("kimi"));

  const sdkOnly = await detectMatrix({ sdk: SDK_VERSION, cli: null });
  assert.equal(sdkOnly.get("kimi")!.models.length, CONFIG_MODELS.length);
  assertNotInstalled(sdkOnly.get("kimi-cli"));
});

test("the two drivers declare separate ids", () => {
  // Asserted on the DRIVERS, not on a detectAllRegistered result. Learned from
  // a mutant: collapsing kimi-cli's id onto "kimi" left an assertion over the
  // enumerated map still green, because detectAllRegistered emits one row per
  // registryId it is handed no matter what the drivers claim. The map answers
  // "was this id asked about", not "does a driver own it" — and the adapter
  // mapping (kimi → kimi-sdk, kimi-cli → kimi) is keyed on the latter.
  const p = probes({ sdk: SDK_VERSION, cli: CLI_VERSION });
  assert.equal(kimiDriver(p).id, "kimi");
  assert.equal(kimiCliDriver(p).id, "kimi-cli");
});
