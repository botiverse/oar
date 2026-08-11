import assert from "node:assert/strict";
import test from "node:test";
import {
  compareCodexVersions,
  parseCodexVersion,
  resolveCodexBin,
  clearCodexProbeCacheForTests,
  type CodexResolveDeps,
} from "./codexResolve.js";

// --- pure version ordering ---

test("parseCodexVersion reads core triple and numeric prerelease trail", () => {
  assert.deepEqual(parseCodexVersion("codex-cli 0.144.6"), { core: [0, 144, 6], pre: null });
  assert.deepEqual(parseCodexVersion("0.147.0-alpha.6.5"), { core: [0, 147, 0], pre: [6, 5] });
  assert.equal(parseCodexVersion("not a version"), null);
});

test("release ranks above a same-core prerelease; higher core wins", () => {
  assert.equal(compareCodexVersions("0.147.0", "0.147.0-alpha.1")! > 0, true);
  assert.equal(compareCodexVersions("0.148.0", "0.147.9")! > 0, true);
  assert.equal(compareCodexVersions("garbage", "0.1.0"), null);
});

// --- resolver (injected probe/which/exists — no subprocess) ---

function deps(over: Partial<CodexResolveDeps>): CodexResolveDeps {
  return {
    env: {},
    platform: "darwin",
    homeDir: "/home/x",
    which: () => null,
    exists: () => false,
    probe: () => ({ appServerOk: false, version: null }),
    ...over,
  };
}

test("arbitration selects the newest app-server-capable candidate", () => {
  clearCodexProbeCacheForTests();
  const bundle = "/Applications/ChatGPT.app/Contents/Resources/codex";
  const r = resolveCodexBin(
    deps({
      which: () => "/usr/local/bin/codex",
      exists: (p) => p === bundle,
      probe: (cmd) =>
        cmd === bundle
          ? { appServerOk: true, version: "0.147.0" }
          : { appServerOk: true, version: "0.140.0" },
    }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.command, bundle);
  assert.equal(r.ok && r.version, "0.147.0");
});

test("a candidate failing the app-server gate is rejected, not selected", () => {
  clearCodexProbeCacheForTests();
  // PATH codex is too old to app-server; bundle is capable → bundle wins.
  const bundle = "/Applications/ChatGPT.app/Contents/Resources/codex";
  const r = resolveCodexBin(
    deps({
      which: () => "/usr/local/bin/codex",
      exists: (p) => p === bundle,
      probe: (cmd) =>
        cmd === bundle
          ? { appServerOk: true, version: "0.130.0" }
          : { appServerOk: false, version: null },
    }),
  );
  assert.equal(r.ok && r.source, "desktop_bundle");
});

test("CODEX_BIN override is authoritative and skips PATH discovery", () => {
  clearCodexProbeCacheForTests();
  const r = resolveCodexBin(
    deps({
      env: { CODEX_BIN: "/opt/codex" },
      exists: (p) => p === "/opt/codex",
      // PATH would resolve to something newer, but override wins regardless.
      which: () => "/usr/local/bin/codex",
      probe: () => ({ appServerOk: true, version: "0.99.0" }),
    }),
  );
  assert.equal(r.ok && r.source, "explicit_bin");
  assert.equal(r.ok && r.command, "/opt/codex");
});

test("set-but-unusable CODEX_BIN fails closed (no PATH fallthrough)", () => {
  clearCodexProbeCacheForTests();
  const r = resolveCodexBin(
    deps({
      env: { CODEX_BIN: "/opt/codex" },
      exists: (p) => p === "/opt/codex" || p === "/usr/local/bin/codex",
      which: () => "/usr/local/bin/codex",
      // override probe fails; a usable PATH candidate exists but must NOT be used.
      probe: (cmd) =>
        cmd === "/opt/codex"
          ? { appServerOk: false, version: null }
          : { appServerOk: true, version: "0.147.0" },
    }),
  );
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, "override_failed");
});

test("invalid CODEX_BIN path fails closed before any probe", () => {
  clearCodexProbeCacheForTests();
  const r = resolveCodexBin(
    deps({ env: { CODEX_BIN: "/nope/codex" }, exists: () => false }),
  );
  assert.equal(!r.ok && r.reason, "override_failed");
});

test("no candidates at all → reason none", () => {
  clearCodexProbeCacheForTests();
  const r = resolveCodexBin(deps({}));
  assert.equal(!r.ok && r.reason, "none");
});
