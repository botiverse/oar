import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { baselineFile, downloadVerified, jsonResponse, nativeVersion, npmSpec, packageDist, readManifest, registryUrl, runtimePin } from "./runtime-common.mjs";

const require = createRequire(new URL("../../packages/oar/package.json", import.meta.url));
const spawnSync = require("cross-spawn").sync;

export function isolatedEnvironment(home) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(?:path|systemroot|windir|comspec|pathext|temp|tmp|https?_proxy|all_proxy|no_proxy|node_extra_ca_certs|ssl_cert_file|ssl_cert_dir)$/iu.test(key)));
  return { ...inherited, HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"),
    APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"),
    CODEX_HOME: path.join(home, ".codex"), GROK_HOME: path.join(home, ".grok"),
    npm_config_userconfig: path.join(home, "user.npmrc"), npm_config_globalconfig: path.join(home, "global.npmrc"),
    npm_config_cache: process.env.npm_config_cache ?? (process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"), "npm-cache") : path.join(homedir(), ".npm")),
    CI: "1", DISABLE_AUTOUPDATER: "1" };
}

function run(command, args, env, timeout = 180_000) {
  const result = spawnSync(command, args, { env, encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`${path.basename(command)} failed: code=${result.status} signal=${result.signal} error=${result.error?.code ?? "none"}\n${result.stderr?.slice(-8192) ?? ""}`);
  }
  return result.stdout;
}

function githubValue(file, name, value) {
  assert.ok(!/[\r\n]/u.test(value), `Expected single-line ${name}`);
  if (file) appendFileSync(file, name ? `${name}=${value}\n` : `${value}\n`);
}

// The package prefix and installation HOME are private to this invocation.
// Publish the verified executable only after download, installation and native
// identity checks succeed. Failure never leaves a fallback path for later steps.
export async function installRuntime(key, file = baselineFile, options = {}) {
  assert.match(key, /^[a-z0-9-]+$/u);
  const reportDirectory = options.reportDirectory ?? path.resolve(process.env.OAR_TRIAL_RUN_DIR ?? "oar-trial-run", "runtime-install");
  mkdirSync(reportDirectory, { recursive: true });
  const reportFile = path.join(reportDirectory, `${key}-${randomUUID()}.json`);
  const report = { key, platform: `${process.platform}-${process.arch}`, startedAt: new Date().toISOString(), status: "failed", stage: "read-pin" };
  const save = () => writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  save();
  try {
    const { manifest, sha256 } = readManifest(file);
    if (manifest.baselineSha256) assert.equal(manifest.baselineSha256, readManifest().sha256, "Candidate record belongs to another baseline");
    const pin = runtimePin(manifest, key);
    assert.match(pin.command, /^[a-zA-Z0-9_-]+$/u);
    assert.match(pin.env, /^OAR_[A-Z0-9_]+$/u);
    report.manifestSha256 = sha256;
    report.baselineSha256 = manifest.baselineSha256 ?? sha256;
    report.expectedVersion = pin.version;
    const directory = mkdtempSync(path.join(options.directory ?? process.env.RUNNER_TEMP ?? tmpdir(), `oar-ci-${key}-`));
    report.directory = directory;
    const home = path.join(directory, "home");
    const prefix = path.join(directory, "prefix");
    mkdirSync(home, { recursive: true });
    const env = isolatedEnvironment(home);
    let binary;
    let npmRoot;
    report.stage = "resolve-artifact";
    save();
    if (pin.archives) {
      const platform = `${process.env.RUNNER_OS ?? ({ linux: "Linux", darwin: "macOS", win32: "Windows" })[process.platform]}-${process.env.RUNNER_ARCH ?? process.arch.toUpperCase()}`;
      const archive = pin.archives[platform];
      assert.ok(archive, `No verified archive for ${platform}`);
      assert.match(archive.sha512, /^[a-f0-9]{128}$/u);
      const dist = { url: archive.url, integrity: `sha512-${Buffer.from(archive.sha512, "hex").toString("base64")}` };
      report.artifact = dist;
      report.stage = "download";
      save();
      const content = await downloadVerified(dist);
      const downloaded = path.join(directory, "download");
      writeFileSync(downloaded, content);
      report.stage = "extract";
      save();
      if (process.platform === "win32") {
        binary = path.join(directory, "agy.exe");
        renameSync(downloaded, binary);
      } else {
        const extracted = path.join(directory, "extracted");
        mkdirSync(extracted);
        run("tar", ["-xzf", downloaded, "-C", extracted], env);
        const files = readdirSync(extracted, { recursive: true }).filter(name => path.basename(name) === "antigravity");
        assert.equal(files.length, 1, "Expected one native Antigravity executable");
        binary = path.join(extracted, files[0]);
        chmodSync(binary, 0o755);
      }
    } else {
      report.spec = npmSpec(pin, key);
      const dist = pin.dist ?? packageDist(await jsonResponse(registryUrl(pin.package, pin.version)), pin.package, pin.version);
      report.artifact = dist;
      report.stage = "download";
      save();
      const content = await downloadVerified(dist);
      const tarball = path.join(directory, "runtime.tgz");
      writeFileSync(tarball, content);
      report.stage = "npm-install";
      save();
      run("npm", ["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org", tarball], env);
      const bin = process.platform === "win32" ? prefix : path.join(prefix, "bin");
      binary = path.join(bin, `${pin.command}${process.platform === "win32" ? ".cmd" : ""}`);
      npmRoot = path.join(prefix, ...(process.platform === "win32" ? [] : ["lib"]), "node_modules");
    }
    report.stage = "native-version";
    save();
    const output = run(binary, ["--version"], env, 30_000).trim();
    report.nativeOutput = output.slice(0, 4096);
    report.actualVersion = nativeVersion(output);
    assert.equal(report.actualVersion, pin.version, "Installed native version differs from the selected pin");
    report.executable = binary;
    report.stage = "publish-path";
    save();
    githubValue(options.githubEnv ?? process.env.GITHUB_ENV, pin.env, binary);
    githubValue(options.githubPath ?? process.env.GITHUB_PATH, "", path.dirname(binary));
    if (npmRoot) githubValue(options.githubEnv ?? process.env.GITHUB_ENV, "OAR_CI_NPM_ROOT", npmRoot);
    report.status = "verified";
    return report;
  } catch (error) {
    report.error = error.message;
    throw error;
  } finally {
    report.endedAt = new Date().toISOString();
    save();
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [key, candidate, ...extra] = process.argv.slice(2);
    assert.ok(key && extra.length === 0, "Usage: runtime-install.mjs <key> [frozen-candidates.json]");
    const report = await installRuntime(key, candidate ?? baselineFile);
    process.stdout.write(`Verified ${key} ${report.actualVersion}; manifest ${report.manifestSha256}\n`);
  } catch (error) {
    process.stderr.write(`Runtime installation failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
