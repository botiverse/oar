import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { grokSharedRefusal } from "../../packages/oar/src/runtimes/grok/sharing-admission.js";
import { grokCandidateRefusal } from "../../experiments/sharing/grok-candidate.js";
import { grokSharedLaunchRefusal } from "../../packages/oar/src/runtimes/grok/shared-session.js";

const installation = { kind: "available", via: "executable", command: "grok", version: "grok 1.0.70 (f50904eaee6c) [stable]" } as const;
test.each(["grok 1.0.70 (f50904eaee6c)", "grok 1.0.70 (f50904eaee6c) [stable]"])("The experimental adapter accepts the observed npm and installer output %j", version => {
  expect(grokCandidateRefusal({ ...installation, version }, "linux", "x64")).toBeNull();
});
test.each([["linux", "x64"], ["darwin", "arm64"], ["win32", "x64"]] as const)("The experimental adapter accepts precisely the measured %s/%s cell", (platform, arch) => {
  expect(grokCandidateRefusal(installation, platform, arch)).toBeNull();
});
test.each([["linux", "arm64"], ["darwin", "x64"], ["win32", "arm64"], ["freebsd", "x64"]] as const)("The experimental adapter rejects unmeasured %s/%s", (platform, arch) => {
  expect(grokCandidateRefusal(installation, platform, arch)).not.toBeNull();
});
test.each(["1.0.70", "grok 1.0.71 (abc) [stable]", "grok 1.0.700 (abc) [stable]", "grok 1.0.70-dev (abc) [stable]", "grok 1.0.70 (abc) [nightly]", "grok 1.0.70 (abc) [beta]", undefined])("unknown installation version %j cannot inherit admission", version => {
  expect(grokCandidateRefusal({ kind: "available", via: "executable", command: "grok", ...(version === undefined ? {} : { version }) }, "linux", "x64")).not.toBeNull();
});
const cwd = os.tmpdir();
const env = { ...Object.fromEntries(Object.keys(process.env).map(key => [key, null])), HOME: cwd, USERPROFILE: cwd, PATH: path.dirname(process.execPath) };
test.each(["HOME", "USERPROFILE", "GROK_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"])("relative %s is not neutral-home evidence", key => {
  expect(grokSharedLaunchRefusal("grok", { cwd, env: { ...env, [key]: "relative" } })).not.toBeNull();
  expect(grokSharedLaunchRefusal("grok", { cwd, env: { ...env, [key]: cwd } })).toBeNull();
});
test("custom arguments, relative command/cwd and relative PATH refuse; discovered absolute executables remain eligible", () => {
  expect(grokSharedLaunchRefusal("grok", { cwd, env })).toBeNull();
  expect(grokSharedLaunchRefusal(process.execPath, { cwd, env: { ...env, GROK_BIN_DIR: "relative-discovery-only" } })).toBeNull();
  expect(grokSharedLaunchRefusal("./grok", { cwd, env })).not.toBeNull();
  expect(grokSharedLaunchRefusal("grok", { cwd: "relative", env })).not.toBeNull();
  expect(grokSharedLaunchRefusal("grok", { cwd, env, launchArgs: ["--trust"] })).not.toBeNull();
  expect(grokSharedLaunchRefusal("grok", { cwd, env: { ...env, PATH: `${path.dirname(process.execPath)}${path.delimiter}.` } })).not.toBeNull();
  expect(grokSharedLaunchRefusal("grok", { cwd, env: { ...env, PATH: "" } })).not.toBeNull();
});

const windows = { cwd: String.raw`C:\project`, env: { ...Object.fromEntries(Object.keys(process.env).map(key => [key, null])),
  HOME: String.raw`C:\Users\fixture`, USERPROFILE: String.raw`C:\Users\fixture`, PATH: String.raw`C:\tools;D:\bin` } };
test.each([String.raw`\tools\grok.exe`, "/tools/grok.exe", "C:grok.exe", "C:"])("Windows executable %j needs a drive or UNC share", command => {
  expect(grokSharedLaunchRefusal(command, windows, "win32")).not.toBeNull();
});
test.each([String.raw`C:\tools\grok.exe`, "D:/tools/grok.exe", String.raw`\\server\share\grok.exe`, "grok"])("Windows executable %j is fully resolved", command => {
  expect(grokSharedLaunchRefusal(command, windows, "win32")).toBeNull();
});
test.each([String.raw`\Users\fixture`, "C:project", "/project"])("Windows cwd/config/PATH %j cannot depend on another drive", value => {
  expect(grokSharedLaunchRefusal("grok", { ...windows, cwd: value }, "win32")).not.toBeNull();
  expect(grokSharedLaunchRefusal("grok", { ...windows, env: { ...windows.env, Home: value } }, "win32")).not.toBeNull();
  expect(grokSharedLaunchRefusal("grok", { ...windows, env: { ...windows.env, Path: value } }, "win32")).not.toBeNull();
});
test("Windows UNC cwd, home and PATH are independent of the process drive", () => {
  const share = String.raw`\\server\share`;
  expect(grokSharedLaunchRefusal("grok", { cwd: `${share}\\project`, env: { ...windows.env, HOME: share, USERPROFILE: share, PATH: share } }, "win32")).toBeNull();
});


test("the production gate never admits Grok, including the previously observed 1.0.70 cells", () => {
  expect(grokSharedRefusal()).toContain("configured stdio MCP servers");
});
