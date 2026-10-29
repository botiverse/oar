import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { orient, RuntimeRegistry } from "../../packages/oar/src/index.js";
import { codebuddyRuntime } from "../../packages/oar/src/runtimes/codebuddy/index.js";
import { codebuddyInstallation } from "../../packages/oar/src/runtimes/codebuddy/installation.js";

let home = ""; let bin = ""; let prefix = ""; let log = "";
const fakeNpm = path.resolve(import.meta.dirname, "../fixtures/fake-npm-install.mjs");
const shellQuote = (value: string): string => `'${value.replaceAll("'", String.raw`'\''`)}'`;

function writeNpm(): void {
  const command = path.join(bin, process.platform === "win32" ? "npm.cmd" : "npm");
  writeFileSync(command, process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "${fakeNpm}" %*\r\n`
    : `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fakeNpm)} "$@"\n`, { mode: 0o755 });
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "oar-codebuddy-install-"));
  bin = path.join(home, "tools"); prefix = path.join(home, "global prefix"); log = path.join(home, "npm.log");
  mkdirSync(bin); writeFileSync(log, ""); writeNpm();
  for (const [key, value] of Object.entries({ HOME: home, USERPROFILE: home, PATH: bin, npm_config_prefix: prefix, OAR_NPM_TEST_LOG: log })) { vi.stubEnv(key, value); }
  vi.stubEnv("OAR_CODEBUDDY_BIN", undefined);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

test("the public installer finds a global bin outside PATH and refuses to reinstall it", async () => {
  expect(await codebuddyRuntime.installPlan()).toMatchObject({ kind: "plan", source: "https://www.codebuddy.ai/docs/cli/installation" });
  expect(readFileSync(log, "utf8")).not.toContain('"install"');
  expect(await codebuddyRuntime.install()).toMatchObject({ kind: "installed", installation: { version: "CodeBuddy Code 0.0.0-fixture" } });
  const found = await codebuddyInstallation();
  expect(found).toMatchObject({ kind: "available", via: "executable", command: path.join(prefix, process.platform === "win32" ? "codebuddy.cmd" : "bin/codebuddy") });
  expect(await codebuddyRuntime.install()).toMatchObject({ kind: "already_installed", installation: found });
  expect(readFileSync(log, "utf8").split("\n").filter((line) => line.startsWith('["install"'))).toHaveLength(1);
}, 20_000);

test("prefix discovery uses the supplied environment and does not change the host", async () => {
  const otherPrefix = path.join(home, "other prefix"); const otherBin = process.platform === "win32" ? otherPrefix : path.join(otherPrefix, "bin");
  mkdirSync(otherBin, { recursive: true });
  writeFileSync(path.join(otherBin, process.platform === "win32" ? "codebuddy.cmd" : "codebuddy"), process.platform === "win32" ? "@echo other-copy\r\n" : "#!/bin/sh\necho other-copy\n", { mode: 0o755 });
  expect(await codebuddyInstallation({ env: { npm_config_prefix: otherPrefix } })).toMatchObject({ kind: "available", version: "other-copy" });
  expect(process.env.npm_config_prefix).toBe(prefix);
});

test("an explicit missing executable remains exclusive and never reads npm", async () => {
  expect(await codebuddyInstallation({ env: { OAR_CODEBUDDY_BIN: path.join(home, "missing") } })).toEqual({ kind: "not_found" });
  expect(readFileSync(log, "utf8")).toBe("");
});

test("missing npm exposes the exact vendor command and does not install", async () => {
  vi.stubEnv("PATH", "");
  const plan = await codebuddyRuntime.installPlan();
  expect(plan).toMatchObject({ kind: "unsupported", reason: "missing_tool", detail: "npm", source: "https://www.codebuddy.ai/docs/cli/installation",
    steps: [{ command: ["npm", "install", "-g", "@tencent-ai/codebuddy-code"], display: "npm install -g @tencent-ai/codebuddy-code" }] });
  expect(await codebuddyRuntime.install()).toEqual(plan);
  expect(readFileSync(log, "utf8")).toBe("");
});

test("broken npm does not reject installation discovery or orientation, but a plan still rejects", async () => {
  vi.stubEnv("OAR_NPM_TEST_FAIL", "1");
  await expect(codebuddyInstallation()).resolves.toEqual({ kind: "not_found" });
  const snapshot = await orient(new RuntimeRegistry([codebuddyRuntime]));
  expect(snapshot.runtimes[0]?.installation).toMatchObject({ kind: "ok", value: { kind: "not_found" } });
  await expect(codebuddyRuntime.installPlan()).rejects.toThrow(/^Could not read npm's global installation directory$/u);
});
