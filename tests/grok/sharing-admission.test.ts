import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { grokSharedRefusal } from "../../packages/oar/src/runtimes/grok/sharing-admission.js";
import { grokSharedLaunchRefusal } from "../../packages/oar/src/runtimes/grok/shared-session.js";

const installation = { kind: "available", via: "executable", command: "grok", version: "grok 1.0.70 (f50904eaee6c) [stable]" } as const;
test.each([["linux", "x64"], ["darwin", "arm64"], ["win32", "x64"]] as const)("Grok admits precisely the measured %s/%s cell", (platform, arch) => {
  expect(grokSharedRefusal(installation, platform, arch)).toBeNull();
});
test.each([["linux", "arm64"], ["darwin", "x64"], ["win32", "arm64"], ["freebsd", "x64"]] as const)("Grok rejects unmeasured %s/%s", (platform, arch) => {
  expect(grokSharedRefusal(installation, platform, arch)).not.toBeNull();
});
test.each(["1.0.70", "grok 1.0.71 (abc) [stable]", "grok 1.0.700 (abc) [stable]", "grok 1.0.70-dev (abc) [stable]", "grok 1.0.70 (abc) [nightly]", undefined])("unknown installation version %j cannot inherit admission", version => {
  expect(grokSharedRefusal({ kind: "available", via: "executable", command: "grok", ...(version === undefined ? {} : { version }) }, "linux", "x64")).not.toBeNull();
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
