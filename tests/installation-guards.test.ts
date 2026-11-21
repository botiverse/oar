/* oxlint-disable import/max-dependencies -- Cross-runtime installation guard contract covers all executable and SDK runtimes. */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, expect, test } from "vitest";
import { createCursorRuntime, createPiRuntime, defaultRuntimes } from "../packages/oar/src/index.js";
import { cursorInstallationFor } from "../packages/oar/src/runtimes/cursor/installation.js";
import { OPENCODE_SUPPORTED_VERSION_RANGE, opencodeInstallation } from "../packages/oar/src/runtimes/opencode/installation.js";
import { piInstallationFor } from "../packages/oar/src/runtimes/pi/installation.js";
import { clearInstallationCache } from "../packages/oar/src/shared/installation.js";
import { satisfiesVersionLine } from "../packages/oar/src/shared/version-range.js";
import { fakeAgentBinary } from "./fixtures/process-tree.js";

const scratch = mkdtempSync(path.join(tmpdir(), "oar-install-guards-"));
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });
afterEach(() => { clearInstallationCache(); });

/** Write a fake executable that prints fixed help/version strings and exits with configured status codes. */
function makeCli(
  name: string,
  spec: { readonly help: string; readonly version: string; readonly versionExitCode?: number; readonly requirePrefix?: string },
): string {
  const dir = mkdtempSync(path.join(scratch, `${name}-`));
  const script = path.join(dir, `${name}.mjs`);
  const versionExit = spec.versionExitCode ?? 0;
  const prefixCheck = spec.requirePrefix === undefined
    ? ""
    : `if (args[0] !== ${JSON.stringify(spec.requirePrefix)}) { process.exit(2); } args.shift();`;
  writeFileSync(script, [
    "const args = process.argv.slice(2);",
    prefixCheck,
    `if (args.includes("--version")) { process.stdout.write(${JSON.stringify(`${spec.version}\n`)}); process.exit(${String(versionExit)}); }`,
    `if (args.includes("--help")) { process.stdout.write(${JSON.stringify(`${spec.help}\n`)}); process.exit(0); }`,
    "process.exit(0);",
  ].join("\n"));
  return fakeAgentBinary(dir, [script]);
}

const EXECUTABLE_RUNTIMES = [
  ["antigravity", "OAR_ANTIGRAVITY_BIN"],
  ["claude", "OAR_CLAUDE_BIN"],
  ["codebuddy", "OAR_CODEBUDDY_BIN"],
  ["codex", "OAR_CODEX_BIN"],
  ["devin", "OAR_DEVIN_BIN"],
  ["dsh", "OAR_DSH_BIN"],
  ["factory", "OAR_FACTORY_BIN"],
  ["grok", "OAR_GROK_BIN"],
  ["kimi", "OAR_KIMI_BIN"],
  ["opencode", "OAR_OPENCODE_BIN"],
  ["qoder", "OAR_QODER_BIN"],
  ["qwen", "OAR_QWEN_BIN"],
] as const;

const foreignBridge = makeCli("acp-bridge", { help: "Usage: acp-bridge [options]\nGeneric ACP bridge", version: "1.0.0" });
const aiderDesk = makeCli("aiderdesk", { help: "AiderDesk CLI", version: "2.4.0" });
const devinAdapter = makeCli("devin-adapter", { help: "Usage: devin acp [options]", version: "devin 3000.12.57 (96542e930752)" });

test.each(EXECUTABLE_RUNTIMES)("%s refuses a non-vendor executable even when every probe exits 0", async (id, envVar) => {
  const runtime = defaultRuntimes.require(id);
  const snapshot = await runtime.installation?.({ env: { [envVar]: foreignBridge, PATH: "" } });
  expect(snapshot).toMatchObject({
    kind: "unsupported",
    code: "unrecognized_executable",
    via: "executable",
    command: foreignBridge,
  });
});

const nearMissBridge = makeCli("vendor-bridge", {
  help: "Usage: vendor-bridge [options]\nACP bridge wrapping kimi, opencode, codebuddy, cbc, qwen, qodercli, dsh, droid, codex, grok, devin and agy",
  version: "bridge 1.18.30",
});

test.each(EXECUTABLE_RUNTIMES)("%s refuses a near-miss bridge whose help mentions the vendor name", async (id, envVar) => {
  const runtime = defaultRuntimes.require(id);
  const snapshot = await runtime.installation?.({ env: { [envVar]: nearMissBridge, PATH: "" } });
  expect(snapshot).toMatchObject({
    kind: "unsupported",
    code: "unrecognized_executable",
    via: "executable",
    command: nearMissBridge,
  });
});

test("a failing --version returns readiness_failed instead of unrecognized_executable", async () => {
  const broken = makeCli("broken-claude", { help: "Usage: claude", version: "", versionExitCode: 1 });
  expect(await defaultRuntimes.require("claude").installation?.({ env: { OAR_CLAUDE_BIN: broken, PATH: "" } })).toEqual({
    kind: "unsupported",
    code: "readiness_failed",
    via: "executable",
    command: broken,
    reason: "--version failed",
  });
});

function writeShellCommand(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, body);
  chmodSync(file, 0o755);
  return file;
}

test.skipIf(process.platform === "win32")("version_unsupported from a vendor fallback takes precedence over an unrelated PATH copy", async () => {
  const home = mkdtempSync(path.join(scratch, "precedence-"));
  const pathBin = path.join(home, "bin");
  writeShellCommand(pathBin, "opencode", "#!/bin/sh\necho 'Usage: opencode-bridge'\nexit 0\n");
  const oldOfficial = writeShellCommand(path.join(home, ".opencode", "bin"), "opencode", "#!/bin/sh\nif [ \"$1\" = \"--help\" ]; then echo '  opencode acp  start ACP'; else echo '1.18.29'; fi\n");

  expect(await opencodeInstallation({ env: { HOME: home, PATH: pathBin, OAR_OPENCODE_BIN: null } })).toMatchObject({
    kind: "unsupported",
    code: "version_unsupported",
    via: "executable",
    command: oldOfficial,
    installedVersion: "1.18.29",
    requiredVersion: OPENCODE_SUPPORTED_VERSION_RANGE,
  });
});

test.each([
  ["Devin adapter", devinAdapter],
  ["ACP bridge", foreignBridge],
  ["AiderDesk", aiderDesk],
] as const)("grok slot refuses %s as unrecognized_executable", async (_label, command) => {
  const snapshot = await defaultRuntimes.require("grok").installation?.({ env: { OAR_GROK_BIN: command, PATH: "" } });
  expect(snapshot).toMatchObject({
    kind: "unsupported",
    code: "unrecognized_executable",
    via: "executable",
    command,
  });
});

const OPENCODE_V2_HELP = "DESCRIPTION\n  OpenCode command line interface\n\nUSAGE\n  opencode <subcommand>";

test.each([
  ["1.18.30", "1.18.30"],
  ["1.19.5", "1.19.5"],
  ["opencode v2.0.27", "opencode v2.0.27"],
  ["opencode v2.2.7", "opencode v2.2.7"],
] as const)("opencode accepts supported 1.x and 2.x releases: %s", async (reported, expectedVersion) => {
  const cli = makeCli("opencode-ok", { help: OPENCODE_V2_HELP, version: reported });
  expect(await opencodeInstallation({ env: { OAR_OPENCODE_BIN: cli, PATH: "" } })).toEqual({
    kind: "available",
    via: "executable",
    command: cli,
    version: expectedVersion,
  });
});

test.each([
  ["0.9.0", "0.9.0"],
  ["1.18.29", "1.18.29"],
  ["1.18.30-beta.1", "1.18.30-beta.1"],
  ["opencode v2.0.0", "2.0.0"],
  ["opencode v2.0.26", "2.0.26"],
  ["opencode v2.0.27-rc.1", "2.0.27-rc.1"],
  ["opencode v3.0.0", "3.0.0"],
  ["opencode v3.0.0-alpha.1", "3.0.0-alpha.1"],
  ["dev-build", undefined],
] as const)("opencode refuses unsupported versions outside 1.x >=1.18.30 / 2.x >=2.0.27 <3: %s", async (reported, installedVersion) => {
  const cli = makeCli("opencode-bad", { help: OPENCODE_V2_HELP, version: reported });
  const snapshot = await opencodeInstallation({ env: { OAR_OPENCODE_BIN: cli, PATH: "" } });
  expect(snapshot).toMatchObject({
    kind: "unsupported",
    code: "version_unsupported",
    via: "executable",
    command: cli,
    requiredVersion: OPENCODE_SUPPORTED_VERSION_RANGE,
  });
  if (installedVersion === undefined) {
    expect(snapshot).not.toHaveProperty("installedVersion");
  } else {
    expect(snapshot).toMatchObject({ installedVersion });
  }
});

test("satisfiesVersionLine enforces inclusive floor, major line and explicit upper bound", () => {
  expect(satisfiesVersionLine("1.5.0", { min: "1.5.0", maxExclusive: "2.0.0" })).toBe(true);
  expect(satisfiesVersionLine("2.0.0", { min: "1.5.0", maxExclusive: "2.0.0" })).toBe(false);
  expect(satisfiesVersionLine("1.5.0-rc.1", { min: "1.5.0", stableOnly: true })).toBe(false);
});

const healthyHost = {
  platform: "linux",
  arch: "x64",
  nodeVersion: "22.13.0",
  electron: false,
  compiledSingleExecutable: false,
  resolveModule: (specifier: string) => `/resolved/${specifier}`,
} as const;

test("cursor installation enforces platform, Node >=22.13, non-SEA and resolvable sdkModule", async () => {
  expect(await cursorInstallationFor("linux", "x64", "subprocess", { sdkModule: "@cursor/sdk", host: healthyHost })())
    .toEqual({ kind: "available", via: "bundled" });

  expect(await cursorInstallationFor("linux", "x64", "in_process", { host: { ...healthyHost, nodeVersion: "22.12.0" } })())
    .toMatchObject({ kind: "unsupported", code: "unsupported_node_version", installedVersion: "22.12.0", requiredVersion: "22.13.0" });

  expect(await cursorInstallationFor("linux", "x64", "subprocess", { sdkModule: "@cursor/sdk", host: { ...healthyHost, compiledSingleExecutable: true } })())
    .toMatchObject({ kind: "unsupported", code: "unsupported_host" });

  // In-process mode does not spawn process.execPath.
  expect(await cursorInstallationFor("linux", "x64", "in_process", { host: { ...healthyHost, compiledSingleExecutable: true } })())
    .toEqual({ kind: "available", via: "bundled" });

  expect(await cursorInstallationFor("linux", "x64", "subprocess", {
    sdkModule: "file:///nonexistent/cursor-sdk.mjs",
    host: { ...healthyHost, resolveModule: () => null },
  })()).toMatchObject({ kind: "unsupported", code: "dependency_missing" });

  const missingRuntime = createCursorRuntime({ execution: "subprocess", sdkModule: path.join(scratch, "missing-cursor-sdk.mjs") });
  expect(await missingRuntime.installation()).toMatchObject({ kind: "unsupported", code: "dependency_missing" });
});

test("pi RPC installation enforces non-SEA, non-Electron and resolvable rpc-entry when no command is given", async () => {
  expect(await piInstallationFor({ execution: "subprocess" }, healthyHost)())
    .toEqual({ kind: "available", via: "bundled" });

  expect(await piInstallationFor({ execution: "subprocess" }, { ...healthyHost, compiledSingleExecutable: true })())
    .toMatchObject({ kind: "unsupported", code: "unsupported_host" });

  expect(await piInstallationFor({ execution: "subprocess" }, { ...healthyHost, electron: true })())
    .toMatchObject({ kind: "unsupported", code: "unsupported_host" });

  expect(await piInstallationFor({ execution: "subprocess" }, {
    ...healthyHost,
    resolveModule: (specifier) => specifier.endsWith("rpc-entry") ? null : `/resolved/${specifier}`,
  })()).toMatchObject({ kind: "unsupported", code: "dependency_missing" });

  // In-process Pi is unaffected by subprocess host constraints.
  expect(await piInstallationFor({}, { ...healthyHost, compiledSingleExecutable: true, electron: true })())
    .toEqual({ kind: "available", via: "bundled" });
});

function expectDependencyMissing(snapshot: Awaited<ReturnType<ReturnType<typeof piInstallationFor>>>, pattern: RegExp): string {
  expect(snapshot).toMatchObject({ kind: "unsupported", code: "dependency_missing" });
  const reason = snapshot.kind === "unsupported" ? snapshot.reason : "";
  expect(reason).toMatch(pattern);
  return reason;
}

test("pi SDK and explicit-command RPC report dependency_missing when optional peers are absent", async () => {
  expectDependencyMissing(
    await piInstallationFor({}, { ...healthyHost, resolveModule: () => null })(),
    /@earendil-works\/pi-coding-agent.*@earendil-works\/pi-ai/u,
  );
  const missingAiReason = expectDependencyMissing(
    await piInstallationFor({}, { ...healthyHost, resolveModule: (specifier) => specifier === "@earendil-works/pi-ai" ? null : `/resolved/${specifier}` })(),
    /@earendil-works\/pi-ai/u,
  );
  expect(missingAiReason).not.toContain("@earendil-works/pi-coding-agent");

  const okPi = makeCli("pi-ok-peers", { help: "pi", version: "1.5.2" });
  expectDependencyMissing(
    await piInstallationFor({ execution: "subprocess", command: okPi }, { ...healthyHost, resolveModule: () => null })(),
    /session lookup.*project-package checks.*context-overflow detection/u,
  );
});

test("pi RPC with an explicit command verifies existence, failing --version, args prefix and version >= 1.4.0", async () => {
  const missing = createPiRuntime({ execution: "subprocess", command: path.join(scratch, "missing-pi") });
  expect(await missing.installation()).toEqual({ kind: "not_found" });

  const brokenPi = makeCli("pi-broken", { help: "pi", version: "", versionExitCode: 1 });
  expect(await piInstallationFor({ execution: "subprocess", command: brokenPi }, { ...healthyHost, compiledSingleExecutable: true, electron: true })())
    .toEqual({ kind: "unsupported", code: "readiness_failed", via: "executable", command: brokenPi, reason: "--version failed" });

  const oldPi = makeCli("pi-old", { help: "pi", version: "1.3.99" });
  expect(await piInstallationFor({ execution: "subprocess", command: oldPi }, { ...healthyHost, compiledSingleExecutable: true, electron: true })())
    .toMatchObject({ kind: "unsupported", code: "version_unsupported", via: "executable", command: oldPi, installedVersion: "1.3.99", requiredVersion: "1.4.0" });

  const okPi = makeCli("pi-ok", { help: "pi", version: "1.5.2", requirePrefix: "pi" });
  expect(await piInstallationFor({ execution: "subprocess", command: okPi, args: ["pi"] }, { ...healthyHost, compiledSingleExecutable: true, electron: true })())
    .toEqual({ kind: "available", via: "bundled" });
});
