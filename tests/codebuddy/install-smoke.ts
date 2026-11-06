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
import { installDiagnostics } from "../fixtures/codebuddy-install-diagnostics.js";

const diagnosticsDirectory = process.env.OAR_CODEBUDDY_INSTALL_DIAGNOSTICS ?? path.resolve(
  process.env.OAR_TRIAL_RUN_DIR ?? "oar-trial-run", "codebuddy-install", `${String(Date.now())}-${String(process.pid)}`,
);
const diagnostics = installDiagnostics(diagnosticsDirectory);

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
  diagnostics.record("discovery_started", { node: process.version, platform: process.platform, arch: process.arch });
  await assertReadOnly(home);
  diagnostics.record("discovery_completed");
  await install();
  diagnostics.record("verification_started");
  await verifyInstallation(prefix);
  diagnostics.record("verification_completed");
}

async function install(): Promise<void> {
  diagnostics.record("install_started", { timeoutMs: 180_000 });
  const result = await codebuddyRuntime.install({ timeoutMs: 180_000 });
  diagnostics.record("install_returned", { kind: result.kind });
  diagnostics.write("install-result.json", JSON.stringify(result, null, 2));
  assert.equal(result.kind, "installed", JSON.stringify(result));
}

function isolatedEnvironment(home: string): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(?:systemroot|windir|comspec|pathext|temp|tmp|https?_proxy|all_proxy|no_proxy|node_extra_ca_certs|ssl_cert_file|ssl_cert_dir)$/iu.test(key)));
  const systemPath = process.platform === "win32" ? [] : ["/usr/bin", "/bin"];
  return { ...inherited, PATH: [path.dirname(process.execPath), ...systemPath].join(path.delimiter),
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"),
    npm_config_prefix: path.join(home, "npm-prefix"), npm_config_cache: path.join(home, "npm-cache"),
    npm_config_userconfig: path.join(home, "user.npmrc"), npm_config_globalconfig: path.join(home, "global.npmrc"),
    npm_config_loglevel: "verbose", npm_config_timing: "true",
    OAR_CODEBUDDY_INSTALL_DIAGNOSTICS: diagnosticsDirectory,
    OAR_TEST: "codebuddy-install", DISABLE_AUTOUPDATER: "1" };
}

if (process.env.OAR_TEST !== "codebuddy-install") { throw new Error("Set OAR_TEST=codebuddy-install to authorize this temporary npm installation"); }
if (process.argv[2] === "child") {
  await verify();
} else {
  const home = await mkdtemp(path.join(tmpdir(), "oar-codebuddy-npm-"));
  diagnostics.record("child_starting", { timeoutMs: 240_000 });
  try {
    const result = await runExecutable(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), import.meta.filename, "child"], {
      env: isolatedEnvironment(home), timeoutMs: 240_000,
    });
    diagnostics.record("child_returned", { ok: result.ok, exitCode: result.exitCode, diagnostics: result.diagnostics });
    diagnostics.write("child-stdout.log", result.stdout);
    diagnostics.write("child-stderr.log", result.stderr);
    assert.ok(result.ok, `${result.stdout}\n${result.stderr}`);
    process.stdout.write(result.stdout);
  } finally {
    await diagnostics.capture(home);
    diagnostics.record("cleanup_started");
    try { await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    catch (error) {
      // Directory cleanup must not replace the installation's result or error.
      const code = asRecord(error)?.code;
      process.stderr.write(`${JSON.stringify({ kind: "codebuddy_install_cleanup_failed", directory: home,
        code: typeof code === "string" ? code : null, message: error instanceof Error ? error.message : String(error) })}\n`);
    }
    diagnostics.record("cleanup_finished");
  }
}
