/** Real npm download in a temporary HOME/prefix. No account, conversation or host-global install.
 * OAR_TEST=codebuddy-install pnpm tsx tests/codebuddy/install-smoke.ts
 */
import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { codebuddyRuntime } from "../../packages/oar/src/runtimes/codebuddy/index.js";
import { runExecutable } from "../../packages/oar/src/shared/executable/index.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";

async function directorySnapshot(directory: string): Promise<readonly object[]> {
  const names = await readdir(directory, { recursive: true });
  return Promise.all(names.toSorted().map(async (name) => {
    const info = await lstat(path.join(directory, name));
    return { name, mode: info.mode, size: info.size, modified: info.mtimeMs };
  }));
}

async function assertReadOnly(home: string): Promise<void> {
  const nodeDirectory = path.dirname(process.execPath);
  const before = await Promise.all([directorySnapshot(home), directorySnapshot(nodeDirectory)]);
  const installation = await codebuddyRuntime.installation();
  assert.equal(installation.kind, "not_found");
  const plan = await codebuddyRuntime.installPlan();
  assert.equal(plan.kind, "plan");
  const after = await Promise.all([directorySnapshot(home), directorySnapshot(nodeDirectory)]);
  assert.deepEqual(after, before, "discovery and planning must leave HOME and Node's installation unchanged");
}

async function verifyInstallation(prefix: string): Promise<void> {
  const found = await codebuddyRuntime.installation();
  assert.ok(found.kind === "available" && found.via === "executable");
  const library = process.platform === "win32" ? path.join(prefix, "node_modules") : path.join(prefix, "lib", "node_modules");
  const contents = await readFile(path.join(library, "@tencent-ai/codebuddy-code/package.json"), "utf8");
  const manifest = asRecord(JSON.parse(contents));
  assert.equal(found.version, manifest?.version, "native reported version must match the installed package");
  assert.equal(found.command, path.join(prefix, process.platform === "win32" ? "codebuddy.cmd" : "bin/codebuddy"));
  const again = await codebuddyRuntime.install();
  assert.equal(again.kind, "already_installed");
  process.stdout.write(`${JSON.stringify({ kind: "installed", version: found.version, globalBinOffPath: true, secondInstall: again.kind })}\n`);
}

async function verify(): Promise<void> {
  const home = process.env.HOME; const prefix = process.env.npm_config_prefix;
  assert.ok(home !== undefined && home !== "" && prefix !== undefined && prefix !== "");
  await assertReadOnly(home);
  const result = await codebuddyRuntime.install({ timeoutMs: 180_000 });
  assert.equal(result.kind, "installed", JSON.stringify(result));
  await verifyInstallation(prefix);
}

function isolatedEnvironment(home: string): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(?:systemroot|windir|comspec|pathext|temp|tmp|https?_proxy|all_proxy|no_proxy|node_extra_ca_certs|ssl_cert_file|ssl_cert_dir)$/iu.test(key)));
  const systemPath = process.platform === "win32" ? [] : ["/usr/bin", "/bin"];
  return { ...inherited, PATH: [path.dirname(process.execPath), ...systemPath].join(path.delimiter),
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"),
    npm_config_prefix: path.join(home, "npm-prefix"), npm_config_cache: path.join(home, "npm-cache"),
    npm_config_userconfig: path.join(home, "user.npmrc"), npm_config_globalconfig: path.join(home, "global.npmrc"),
    OAR_TEST: "codebuddy-install", DISABLE_AUTOUPDATER: "1" };
}

if (process.env.OAR_TEST !== "codebuddy-install") { throw new Error("Set OAR_TEST=codebuddy-install to authorize this temporary npm installation"); }
if (process.argv[2] === "child") {
  await verify();
} else {
  const home = await mkdtemp(path.join(tmpdir(), "oar-codebuddy-npm-"));
  try {
    const result = await runExecutable(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), import.meta.filename, "child"], {
      env: isolatedEnvironment(home), timeoutMs: 240_000,
    });
    assert.ok(result.ok, `${result.stdout}\n${result.stderr}`);
    process.stdout.write(result.stdout);
  } finally { await rm(home, { recursive: true, force: true }); }
}
