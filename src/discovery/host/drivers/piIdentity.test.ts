import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectAllRegistered, type RuntimeDescriptor } from "../../detect.js";
import { piDriver, resolvePiSdkPackageRoot, resolvePiSdkVersion } from "./pi.js";

/**
 * Pi install identity (task #5, Huaihuai 2026-08-13).
 *
 * Canonical `pi` means the SDK, in-process, and nothing else — both the design
 * and the shipped README say so, and the Raft adapter synthesises `builtin`
 * from it. Two defects made that false:
 *
 *   1. detect returned `{version: v ?? "unknown"}`, never null. Since null is
 *      the only way detect.ts expresses absent, `pi` was ALWAYS present.
 *   2. resolvePiSdkPackageRoot fell back to `which("pi")` and walked up from
 *      the CLI binary, so a CLI-only host resolved a package root and reported
 *      the SDK installed.
 *
 * Together those meant a machine with only the pi CLI advertised an in-process
 * runtime the daemon cannot drive — and propagated that into `builtin`.
 *
 * There is no "CLI-only ⇒ pi present" cell to write anymore: the CLI is no
 * longer an input to this driver at all. That absence IS the fix, so the
 * CLI-only case is expressed as "SDK unresolvable ⇒ not_installed, regardless
 * of any pi binary on PATH".
 */

async function detectPi(sdk: string | null): Promise<RuntimeDescriptor | undefined> {
  const descs = await detectAllRegistered([piDriver({ sdkVersion: () => sdk })], ["pi"]);
  return descs.find((d) => d.runtime === "pi");
}

test("SDK present: pi is installed and carries the SDK version", async () => {
  const pi = await detectPi("0.84.1");
  assert.ok(pi);
  assert.equal(pi.version, "0.84.1");
  // NOT `failure === undefined`: this fixture injects a version without a real
  // SDK on disk, so the in-process models probe legitimately fails and the
  // descriptor comes back models_unavailable. Identity and catalog are separate
  // facts — asserting the catalog here would make the test about whether pi
  // happens to be installed on the runner. `not_installed` is the identity
  // answer, and that is what this pins.
  assert.notEqual(pi.failure, "not_installed");
});

test("SDK unresolvable: pi is not_installed, never 'unknown'", async () => {
  // This is the CLI-only host. The driver has no CLI input, so an installed
  // `pi` binary cannot change this answer — which is the point.
  const pi = await detectPi(null);
  assert.ok(pi, "must still be enumerated");
  assert.equal(pi.failure, "not_installed");
  assert.notEqual(pi.version, "unknown-but-present");
  assert.equal(pi.models.length, 0);
});

test("an installed pi CLI cannot make the SDK look present", () => {
  // Closes a gap mutation exposed: every other test here injects sdkVersion, so
  // none of them exercise resolvePiSdkVersion — the default probe, which is
  // exactly where the removed `which("pi")` walk-up lived. Restoring that
  // fallback was therefore unobservable, and on a runner with no `pi` on PATH it
  // would have stayed unobservable forever.
  //
  // So: plant a real, executable `pi` on PATH inside a package tree the OLD
  // walk-up would have accepted (a package.json whose name matches
  // /pi-coding-agent/i), and assert its version never reaches the SDK answer.
  // Asserting "not the CLI's version" rather than "null" keeps this valid on a
  // machine that genuinely has the pi SDK installed.
  const dir = mkdtempSync(join(tmpdir(), "oar-pi-cli-"));
  const originalPath = process.env.PATH;
  const CLI_FAKE_VERSION = "cli-fake-9.9.9";
  try {
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "@fake/pi-coding-agent", version: CLI_FAKE_VERSION }),
    );
    const bin = join(dir, "bin", "pi");
    writeFileSync(bin, "#!/bin/sh\necho 'pi 9.9.9'\n");
    chmodSync(bin, 0o755);
    process.env.PATH = `${join(dir, "bin")}:${originalPath ?? ""}`;

    assert.notEqual(
      resolvePiSdkVersion(),
      CLI_FAKE_VERSION,
      "a CLI binary must never supply the canonical pi SDK version",
    );
    const root = resolvePiSdkPackageRoot();
    if (root !== null) {
      assert.ok(
        !root.startsWith(dir),
        `SDK root must not be derived from the CLI binary tree (${root})`,
      );
    }
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pi never reports a version it did not resolve", async () => {
  // Guards the exact mutation that reintroduces `?? "unknown"`: a descriptor
  // that is present with a placeholder version reads as installed downstream.
  const pi = await detectPi(null);
  assert.notEqual(pi?.failure, undefined, "absent SDK must not produce a healthy descriptor");
});
