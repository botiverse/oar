import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { InstallPlanner, InstallUnsupported } from "../packages/oar/src/contracts/install.js";
import {
  planInstaller,
  type InstallLineOf,
  scriptInstallPlanOn,
  unwritableAncestor,
  type InstallHost,
  type ScriptInstallMethod,
} from "../packages/oar/src/shared/install.js";
import { executableInstallation } from "../packages/oar/src/shared/installation.js";

let dir = "";

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "oar-install-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Mode = "install" | "elsewhere" | "fail" | "fail-after" | "prompt" | "hang";

interface FakeInstall {
  /** Where the fake installer puts the runtime, and where the probe looks. */
  readonly target: string;
  readonly plan: InstallPlanner;
  readonly probe: ReturnType<typeof executableInstallation>;
  readonly read: () => Record<string, unknown>;
}

const fakeInstaller = path.join(import.meta.dirname, "fixtures", "fake-installer.mjs");

/** A vendor installer (fixtures/fake-installer.mjs) and a probe that looks only where it installs. */
function fakeInstall(name: string, mode: Mode): FakeInstall {
  const stateFile = path.join(dir, `${name}.json`);
  const target = path.join(dir, process.platform === "win32" ? `${name}.cmd` : name);
  writeFileSync(stateFile, JSON.stringify({ target, mode }));
  const plan: InstallPlanner = async () => {
    await Promise.resolve();
    return {
      kind: "plan",
      steps: [{ command: [process.execPath, fakeInstaller, stateFile], display: `install ${name}` }],
      source: "https://example.invalid/install",
      network: true,
      privileges: false,
    };
  };
  const read = (): Record<string, unknown> => {
    const parsed: unknown = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.ok(typeof parsed === "object" && parsed !== null);
    return Object.fromEntries(Object.entries(parsed));
  };
  return { target, plan, probe: executableInstallation("OAR_FIXTURE_INSTALL_BIN", "oar-fixture-not-on-path", [target]), read };
}

async function withUserAgent<T>(body: () => Promise<T>): Promise<T> {
  const previous = process.env.npm_config_user_agent;
  process.env.npm_config_user_agent = "pnpm/11.22.0";
  try {
    return await body();
  } finally {
    if (previous === undefined) {
      delete process.env.npm_config_user_agent;
    } else {
      process.env.npm_config_user_agent = previous;
    }
  }
}

test("an install is judged by the installation probe afterwards", async () => {
  const fake = fakeInstall("installs", "install");
  const result = await withUserAgent(async () => planInstaller(fake.probe, fake.plan)());
  assert.deepEqual(result, {
    kind: "installed",
    installation: { kind: "available", via: "executable", command: fake.target, version: "fake 1.0.0" },
    output: "Installed fake 1.0.0\n",
  });
  assert.equal(fake.read().sawUserAgent, false);
});

test("an installation the probe finds first means no installer runs", async () => {
  const fake = fakeInstall("present", "fail");
  writeFileSync(fake.target, process.platform === "win32" ? "@echo fake 0.9.0\r\n" : "#!/bin/sh\necho 'fake 0.9.0'\n");
  chmodSync(fake.target, 0o755);
  const result = await planInstaller(fake.probe, fake.plan)();
  assert.deepEqual(result, {
    kind: "already_installed",
    installation: { kind: "available", via: "executable", command: fake.target, version: "fake 0.9.0" },
  });
  assert.equal(fake.read().ran, undefined);
});

const lineOf: InstallLineOf = (installation) => (installation.via === "executable" && installation.version?.includes(" v2.") === true ? "v2" : "v1");

test("a copy of another release line is already installed, and nothing replaces it", async () => {
  const fake = fakeInstall("other-line", "install");
  writeFileSync(fake.target, process.platform === "win32" ? "@echo opencode v2.0.26\r\n" : "#!/bin/sh\necho 'opencode v2.0.26'\n");
  chmodSync(fake.target, 0o755);
  const result = await planInstaller(fake.probe, fake.plan, lineOf)({ line: "v1" });
  assert.deepEqual(result, {
    kind: "already_installed",
    installation: { kind: "available", via: "executable", command: fake.target, version: "opencode v2.0.26" },
    line: "v2",
  });
  assert.equal(fake.read().ran, undefined);
});

test("an installer that claims success but leaves nothing the probe finds is failed", async () => {
  const fake = fakeInstall("elsewhere", "elsewhere");
  const result = await planInstaller(fake.probe, fake.plan)();
  assert.deepEqual(result, { kind: "failed", exitCode: 0, output: "fake installed successfully!\n" });
});

test("a failing installer is failed with its exit code and output", async () => {
  const fake = fakeInstall("fails", "fail");
  const result = await planInstaller(fake.probe, fake.plan)();
  assert.deepEqual(result, { kind: "failed", exitCode: 3, output: "error: failed to download fake\n" });
});

test("a non-zero exit after the runtime is in place is installed, not failed", async () => {
  const fake = fakeInstall("fails-after", "fail-after");
  const result = await planInstaller(fake.probe, fake.plan)();
  assert.ok(result.kind === "installed");
  assert.equal(result.output, "Installed fake 1.0.0\nerror: could not write shell completions\n");
});

test("an unsupported plan is the install's answer, steps included, and nothing runs", async () => {
  const fake = fakeInstall("unsupported", "install");
  const unsupported: InstallUnsupported = {
    kind: "unsupported",
    reason: "missing_tool",
    detail: "curl",
    steps: [{ command: [process.execPath, fakeInstaller, path.join(dir, "unsupported.json")], display: "install unsupported" }],
    source: "https://example.invalid/install",
  };
  const plan: InstallPlanner = async () => {
    await Promise.resolve();
    return unsupported;
  };
  assert.deepEqual(await planInstaller(fake.probe, plan)(), unsupported);
  assert.equal(existsSync(fake.target), false);
});

test("an installer that prompts reads end of input instead of waiting", async () => {
  const fake = fakeInstall("prompts", "prompt");
  const started = Date.now();
  const result = await planInstaller(fake.probe, fake.plan)({ timeoutMs: 20_000 });
  assert.equal(result.kind, "failed");
  assert.ok(Date.now() - started < 15_000);
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test.skipIf(process.platform === "win32")("a timed out installer is stopped with everything it started", async () => {
  const fake = fakeInstall("hangs", "hang");
  // Long enough for the fake installer to start its worker on a loaded machine.
  const result = await planInstaller(fake.probe, fake.plan)({ timeoutMs: 5000 });
  assert.ok(result.kind === "failed");
  assert.equal(result.exitCode, null);
  assert.match(result.output, /stopped the installer after 5000 ms/u);
  const worker = fake.read().workerPid;
  assert.equal(typeof worker, "number");
  await expect.poll(() => alive(Number(worker)), { timeout: 5000 }).toBe(false);
});

const method: ScriptInstallMethod = {
  source: "https://example.invalid/docs",
  line: "curl -fsSL https://example.invalid/install.sh | bash",
  tools: ["curl", "bash"],
  writes: () => ["/home/oar/.example/bin", "/home/oar/.example"],
  windows: "Example documents, in PowerShell: irm https://example.invalid/install.ps1 | iex",
};

const linux: InstallHost = {
  platform: "linux",
  arch: "arm64",
  locate: (tool) => `/usr/bin/${tool}`,
  unwritable: () => null,
};

test("a script plan runs the documented line through sh", () => {
  assert.deepEqual(scriptInstallPlanOn(method, linux), {
    kind: "plan",
    steps: [{ command: ["sh", "-c", method.line], display: method.line }],
    source: method.source,
    network: true,
    privileges: false,
  });
});

test("a script plan off macOS and Linux, or off x64 and arm64, is platform, without the script's steps", () => {
  const windows = scriptInstallPlanOn(method, { ...linux, platform: "win32", arch: "x64" });
  assert.equal(windows.kind === "unsupported" ? windows.reason : windows.kind, "platform");
  assert.match(windows.kind === "unsupported" ? windows.detail ?? "" : "", /irm https:\/\/example\.invalid\/install\.ps1/u);
  const freebsd = scriptInstallPlanOn(method, { ...linux, platform: "freebsd" });
  assert.equal(freebsd.kind === "unsupported" ? freebsd.reason : freebsd.kind, "platform");
  const ia32 = scriptInstallPlanOn(method, { ...linux, arch: "ia32" });
  assert.equal(ia32.kind === "unsupported" ? ia32.reason : ia32.kind, "platform");
  for (const answer of [windows, freebsd, ia32]) {
    assert.deepEqual([Object.hasOwn(answer, "steps"), Object.hasOwn(answer, "source")], [false, false], JSON.stringify(answer));
  }
});

test("a missing tool or a directory this user cannot write still carries the steps the plan would have had", () => {
  const planned = scriptInstallPlanOn(method, linux);
  assert.ok(planned.kind === "plan", JSON.stringify(planned));
  const { steps, source } = planned;
  assert.deepEqual(
    scriptInstallPlanOn(method, { ...linux, locate: (tool) => (tool === "curl" ? null : `/usr/bin/${tool}`) }),
    { kind: "unsupported", reason: "missing_tool", detail: "curl", steps, source },
  );
  assert.deepEqual(
    scriptInstallPlanOn(method, { ...linux, unwritable: (target) => (target === "/home/oar/.example" ? "/home/oar" : null) }),
    {
      kind: "unsupported",
      reason: "requires_privileges",
      detail: "the installer writes /home/oar/.example, and /home/oar is not writable by this user",
      steps,
      source,
    },
  );
});

const runsAsRoot = process.getuid?.() === 0;

test.skipIf(process.platform === "win32" || runsAsRoot)("a directory the installer would create is writable when its nearest existing parent is", () => {
  const locked = path.join(dir, "locked");
  mkdirSync(locked);
  chmodSync(locked, 0o555);
  try {
    assert.equal(unwritableAncestor(path.join(dir, "free", "bin")), null);
    assert.equal(unwritableAncestor(path.join(locked, "kimi-code", "bin")), locked);
  } finally {
    chmodSync(locked, 0o755);
  }
});
