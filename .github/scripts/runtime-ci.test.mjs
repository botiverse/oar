import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { downloadVerified, exactVersion, nativeVersion, packageDist, readManifest } from "./runtime-common.mjs";
import { freezeCandidates } from "./runtime-candidates.mjs";
import { installRuntime, isolatedEnvironment } from "./runtime-install.mjs";
import { rewriteSdkManifests } from "./runtime-sdk-candidate.mjs";

const require = createRequire(new URL("../../packages/oar/package.json", import.meta.url));
const spawnSync = require("cross-spawn").sync;
const hash = bytes => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const workspace = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url)));

async function serverFor(handler, use) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { return await use(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

function metadata(name, version, dependencies = {}) {
  return { name, version, dependencies, dist: { tarball: `https://example.invalid/${encodeURIComponent(name)}.tgz`, integrity: hash(Buffer.from(name)) } };
}

function fakeRegistry(url) {
  const [, encoded, selector] = new URL(url).pathname.split("/");
  const name = decodeURIComponent(encoded);
  const version = selector === "latest" ? workspace.devDependencies[name] : decodeURIComponent(selector);
  assert.ok(exactVersion(version), `No fake registry entry: ${url}`);
  return metadata(name, version, name === "@earendil-works/pi-coding-agent" ? { undici: workspace.devDependencies.undici } : {});
}

test("manifest identity ignores checkout line endings but still detects changed pins", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "oar-ci-manifest-"));
  try {
    const manifest = { schemaVersion: 1, runtimes: { fixture: { package: "fixture", version: "1.2.3" } } };
    const lf = path.join(directory, "lf.json");
    const crlf = path.join(directory, "crlf.json");
    const changed = path.join(directory, "changed.json");
    const text = JSON.stringify(manifest, null, 2) + "\n";
    writeFileSync(lf, text);
    writeFileSync(crlf, text.replaceAll("\n", "\r\n"));
    writeFileSync(changed, text.replace("1.2.3", "1.2.4"));
    assert.deepEqual(readManifest(lf).manifest, readManifest(crlf).manifest);
    assert.equal(readManifest(lf).sha256, readManifest(crlf).sha256);
    assert.notEqual(readManifest(lf).sha256, readManifest(changed).sha256);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("a candidate from changed accepted pins fails before installation or publication", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "oar-ci-stale-"));
  try {
    const manifestFile = path.join(directory, "candidate.json");
    const current = readManifest();
    const changed = { ...current.manifest, schemaVersion: 1, baselineSha256: "0".repeat(64) };
    writeFileSync(manifestFile, JSON.stringify(changed));
    const githubEnv = path.join(directory, "github-env");
    const githubPath = path.join(directory, "github-path");
    const reportDirectory = path.join(directory, "reports");
    await assert.rejects(installRuntime("opencode-cleanup", manifestFile, { directory, githubEnv, githubPath, reportDirectory }), /another baseline/u);
    assert.equal(existsSync(githubEnv), false);
    assert.equal(existsSync(githubPath), false);
    const report = JSON.parse(readFileSync(path.join(reportDirectory, readdirSync(reportDirectory)[0])));
    assert.equal(report.stage, "read-pin");
    assert.equal(report.status, "failed");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("native versions compare complete tokens, including prereleases", () => {
  for (const output of ["1.2.3", "codex-cli 1.2.3", "1.2.3 (Claude Code)", "opencode v1.2.3"]) assert.equal(nativeVersion(output), "1.2.3");
  assert.equal(nativeVersion("dsh 0.2.1-rc.5"), "0.2.1-rc.5");
  for (const output of ["", "no version", "v01.2.3", "1.2.3.4", "1.2.3 and 2.0.0", "1.2.3-01"]) {
    assert.throws(() => nativeVersion(output));
  }
});

test("registry identity and integrity are required", () => {
  assert.throws(() => packageDist(metadata("wrong", "1.2.3"), "expected", "1.2.3"));
  assert.throws(() => packageDist(metadata("expected", "1.2.4"), "expected", "1.2.3"));
  assert.throws(() => packageDist({ name: "expected", version: "1.2.3", dist: { tarball: "https://example.invalid/a" } }, "expected", "1.2.3"));
});

test("package metadata requires HTTPS and a complete SHA-512 digest", () => {
  const valid = metadata("fixture", "1.2.3");
  assert.deepEqual(packageDist(valid, "fixture", "1.2.3"), { url: valid.dist.tarball, integrity: valid.dist.integrity });
  for (const tarball of ["http://example.invalid/pkg.tgz", "file:///tmp/pkg.tgz", "//example.invalid/pkg.tgz"]) {
    assert.throws(() => packageDist({ ...valid, dist: { ...valid.dist, tarball } }, "fixture", "1.2.3"), /HTTPS/u);
  }
  for (const integrity of [undefined, "sha1-" + "a".repeat(28), "sha256-" + "a".repeat(44), "sha512-YQ=="]) {
    assert.throws(() => packageDist({ ...valid, dist: { ...valid.dist, integrity, shasum: "a".repeat(40) } }, "fixture", "1.2.3"), /SHA-512/u);
  }
});

test("a missing or corrupt tarball fails instead of selecting another version", async () => {
  const bytes = Buffer.from("frozen package");
  await serverFor((request, response) => {
    response.statusCode = request.url === "/missing" ? 404 : 200;
    response.end(bytes);
  }, async url => {
    await assert.rejects(downloadVerified({ url: `${url}/missing`, integrity: hash(bytes) }), /HTTP 404/u);
    await assert.rejects(downloadVerified({ url, integrity: hash(Buffer.from("other bytes")) }), /integrity mismatch/u);
    assert.deepEqual(await downloadVerified({ url, integrity: hash(bytes) }), bytes);
  });
});

function attemptRecorder() {
  const attempts = [];
  return { attempts, retryDelayMs: 0, onAttempt: record => { attempts[record.attempt - 1] = record; } };
}

test("download retries discard a partial socket response and verify the complete retry", async () => {
  const bytes = Buffer.from("complete frozen archive");
  const records = attemptRecorder();
  let calls = 0;
  await serverFor((_request, response) => {
    if (++calls === 1) {
      response.writeHead(200, { "Content-Length": bytes.length });
      response.write(bytes.subarray(0, 3));
      setTimeout(() => response.destroy(), 20);
    } else response.end(bytes);
  }, async url => {
    assert.deepEqual(await downloadVerified({ url, integrity: hash(bytes) }, records), bytes);
  });
  assert.equal(calls, 2);
  assert.equal(records.attempts[0].failure, "UND_ERR_SOCKET");
  assert.equal(records.attempts[0].retrying, true);
  assert.equal(records.attempts[1].status, "verified");
});

for (const recover of [true, false]) test(`HTTP 5xx downloads stop within three attempts (recover=${recover})`, async () => {
  const bytes = Buffer.from("fixed artifact");
  const records = attemptRecorder();
  let calls = 0;
  await serverFor((_request, response) => {
    response.statusCode = ++calls === 3 && recover ? 200 : 503;
    response.end(bytes);
  }, async url => {
    const download = downloadVerified({ url, integrity: hash(bytes) }, records);
    if (recover) assert.deepEqual(await download, bytes);
    else await assert.rejects(download, /HTTP 503/u);
  });
  assert.equal(calls, 3);
  assert.deepEqual(records.attempts.map(record => record.attempt), [1, 2, 3]);
  assert.deepEqual(records.attempts.map(record => record.retrying ?? false), [true, true, false]);
  assert.ok(records.attempts.every(record => record.startedAt && record.endedAt));
});

test("stalled response bodies time out on all three attempts", async () => {
  const records = { ...attemptRecorder(), timeoutMs: 500 };
  let calls = 0;
  await serverFor((_request, response) => {
    calls++;
    response.writeHead(200, { "Content-Length": 100 });
    response.write("partial");
  }, async url => {
    await assert.rejects(downloadVerified({ url, integrity: hash(Buffer.from("expected")) }, records), { name: "TimeoutError" });
  });
  assert.equal(calls, 3);
  assert.deepEqual(records.attempts.map(record => record.failure), ["TIMEOUT", "TIMEOUT", "TIMEOUT"]);
  assert.equal(records.attempts[2].retrying, false);
});

for (const status of [401, 404, 429]) test(`HTTP ${status} is never retried`, async () => {
  const records = attemptRecorder();
  let calls = 0;
  await serverFor((_request, response) => { calls++; response.statusCode = status; response.end(); }, async url => {
    await assert.rejects(downloadVerified({ url, integrity: hash(Buffer.from("expected")) }, records), new RegExp(`HTTP ${status}`, "u"));
  });
  assert.equal(calls, 1);
  assert.equal(records.attempts[0].retrying, false);
});

for (const recover of [false, true]) test(`a checksum mismatch never starts another download (after recovery=${recover})`, async () => {
  const records = attemptRecorder();
  let calls = 0;
  await serverFor((_request, response) => {
    calls++;
    response.statusCode = recover && calls === 1 ? 502 : 200;
    response.end("corrupt");
  }, async url => {
    await assert.rejects(downloadVerified({ url, integrity: hash(Buffer.from("expected")) }, records), /integrity mismatch/u);
  });
  assert.equal(calls, recover ? 2 : 1);
  assert.equal(records.attempts.at(-1).failure, "INTEGRITY");
  assert.equal(records.attempts.at(-1).retrying, false);
});

test("recognized socket and timeout causes have a three-attempt ceiling", async t => {
  for (const code of ["ECONNRESET", "EPIPE", "ETIMEDOUT", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]) {
    const records = attemptRecorder();
    let calls = 0;
    const error = new TypeError("fetch failed", { cause: Object.assign(new Error("fixture"), { code }) });
    const mock = t.mock.method(globalThis, "fetch", async () => { calls++; throw error; });
    try {
      await assert.rejects(downloadVerified({ url: "https://example.invalid", integrity: hash(Buffer.from("expected")) }, records), value => value === error);
      assert.equal(calls, 3);
      assert.deepEqual(records.attempts.map(record => record.failure), [code, code, code]);
      assert.deepEqual(records.attempts.map(record => record.retrying), [true, true, false]);
    } finally { mock.mock.restore(); }
  }
});

test("unclassified fetch and certificate failures do not retry", async t => {
  for (const code of [undefined, "CERT_HAS_EXPIRED", "ENOTFOUND", "ABORT_ERR"]) {
    const records = attemptRecorder();
    let calls = 0;
    const error = new TypeError("fetch failed", { cause: Object.assign(new Error("fixture"), { code }) });
    const mock = t.mock.method(globalThis, "fetch", async () => { calls++; throw error; });
    try {
      await assert.rejects(downloadVerified({ url: "https://example.invalid", integrity: hash(Buffer.from("expected")) }, records), value => value === error);
      assert.equal(calls, 1);
      assert.equal(records.attempts[0].retrying, false);
    } finally { mock.mock.restore(); }
  }
});

test("archive installer persists retries and stops at a checksum mismatch without publishing a path", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "oar-archive-retry-test-"));
  let calls = 0;
  try {
    await serverFor((_request, response) => { response.statusCode = ++calls === 1 ? 503 : 200; response.end("corrupt"); }, async url => {
      const manifestFile = path.join(directory, "pins.json");
      const platform = `${process.env.RUNNER_OS ?? ({ linux: "Linux", darwin: "macOS", win32: "Windows" })[process.platform]}-${process.env.RUNNER_ARCH ?? process.arch.toUpperCase()}`;
      writeFileSync(manifestFile, JSON.stringify({ schemaVersion: 1, runtimes: { agy: {
        version: "1.2.3", command: "agy", env: "OAR_AGY_BIN", archives: { [platform]: { url, sha512: "a".repeat(128) } },
      } } }));
      const githubEnv = path.join(directory, "env");
      const githubPath = path.join(directory, "path");
      const reportDirectory = path.join(directory, "reports");
      await assert.rejects(installRuntime("agy", manifestFile, { directory, githubEnv, githubPath, reportDirectory }), /integrity mismatch/u);
      assert.equal(calls, 2);
      const report = JSON.parse(readFileSync(path.join(reportDirectory, readdirSync(reportDirectory)[0])));
      assert.equal(report.stage, "download");
      assert.deepEqual(report.downloadAttempts.map(record => record.failure), ["HTTP", "INTEGRITY"]);
      assert.deepEqual(report.downloadAttempts.map(record => record.retrying), [true, false]);
      assert.equal(existsSync(githubEnv), false);
      assert.equal(existsSync(githubPath), false);
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("one package is resolved once for multiple purposes and never mutates accepted pins", async () => {
  const entry = { package: "fixture", version: "1.0.0", platforms: ["ubuntu-latest", "windows-latest"], suite: "behavior", policy: "accepted" };
  const baseline = { sha256: "fixture", manifest: { schemaVersion: 1, runtimes: { first: entry, second: { ...entry, version: "1.1.0", policy: "helper" } } } };
  const original = JSON.stringify(baseline);
  let calls = 0;
  const frozen = await freezeCandidates({ baseline, request: async url => {
    if (url.endsWith("/fixture/latest")) return metadata("fixture", `2.0.${calls++}`);
    return fakeRegistry(url);
  } });
  assert.equal(calls, 1);
  assert.equal(frozen.runtimes.first.version, "2.0.0");
  assert.equal(frozen.runtimes.second.version, "2.0.0");
  assert.equal(frozen.matrix.include.length, 4);
  assert.equal(frozen.runtimes.first.policy, "accepted");
  assert.equal(frozen.runtimes.second.policy, "helper");
  assert.equal(JSON.stringify(baseline), original);
  assert.deepEqual(frozen.errors, []);
  assert.equal(frozen.sdkMatrix.include.length, 0);
});

test("minimum and replay purposes are excluded even if they have native suites", async () => {
  const entry = { package: "must-not-resolve", version: "1.0.0", platforms: ["ubuntu-latest"], suite: "behavior" };
  const baseline = { sha256: "fixture", manifest: { schemaVersion: 1, runtimes: {
    floor: { ...entry, policy: "minimum" }, replay: { ...entry, policy: "replay" },
  } } };
  const frozen = await freezeCandidates({ baseline, request: async url => {
    assert.ok(!url.includes("must-not-resolve"));
    return fakeRegistry(url);
  } });
  assert.deepEqual(frozen.errors, []);
  assert.deepEqual(frozen.runtimes, {});
  assert.deepEqual(frozen.matrix.include, []);
  assert.deepEqual(frozen.excluded.map(entry => entry.key), ["floor", "replay"]);
});

test("discovery retains errors while other candidates keep their frozen matrix", async () => {
  const entry = { version: "1.0.0", platforms: ["ubuntu-latest"], suite: "behavior" };
  const baseline = { sha256: "fixture", manifest: { schemaVersion: 1, runtimes: {
    missing: { ...entry, package: "missing" }, good: { ...entry, package: "good" },
    floor: { ...entry, package: "floor", suite: null },
  } } };
  const frozen = await freezeCandidates({ baseline, request: async url => {
    if (url.endsWith("/missing/latest")) throw new Error("registry 404");
    if (url.endsWith("/good/latest")) return metadata("good", "2.0.0");
    assert.ok(!url.includes("/floor/"), "minimum-only entry must not become a daily bump");
    return fakeRegistry(url);
  } });
  assert.deepEqual(frozen.errors, [{ key: "missing", error: "registry 404" }]);
  assert.deepEqual(frozen.matrix.include, [{ key: "good", os: "ubuntu-latest", suite: "behavior" }]);
});

test("inconsistent platform archive versions are retained as discovery errors", async () => {
  const baseline = { sha256: "fixture", manifest: { schemaVersion: 1, runtimes: { agy: {
    version: "1.0.0", suite: "acp", platforms: ["ubuntu-latest"], archives: { linux: { source: "https://fixture.invalid/linux" }, mac: { source: "https://fixture.invalid/mac" } },
  } } } };
  const frozen = await freezeCandidates({ baseline, request: async url => url.includes("fixture.invalid")
    ? { version: url.endsWith("linux") ? "2.0.0" : "2.0.1", url: "https://fixture.invalid/archive", sha512: "a".repeat(128) } : fakeRegistry(url) });
  assert.equal(frozen.errors[0].key, "agy");
  assert.match(frozen.errors[0].error, /Platform manifests disagree/u);
  assert.equal(frozen.matrix.include.length, 0);
});

test("a release channel cannot silently install a different registry version", async () => {
  const baseline = { sha256: "fixture", manifest: { schemaVersion: 1, runtimes: { grok: {
    package: "fixture", version: "1.0.0", suite: "acp", platforms: ["ubuntu-latest"], channel: "https://fixture.invalid/stable",
  } } } };
  const frozen = await freezeCandidates({ baseline, stableVersion: async () => "2.0.0",
    request: async url => url.endsWith("/fixture/2.0.0") ? metadata("fixture", "2.0.1") : fakeRegistry(url) });
  assert.match(frozen.errors[0].error, /Registry disagrees/u);
  assert.equal(frozen.matrix.include.length, 0);
});

test("SDK candidates retain all supported OS cases and the two Windows Pi RPC phases", async () => {
  const baseline = { sha256: "fixture", manifest: { schemaVersion: 1, runtimes: {} } };
  const frozen = await freezeCandidates({ baseline, request: async url => {
    const result = fakeRegistry(url);
    if (result.name === "@earendil-works/pi-coding-agent") result.version = "9.0.0";
    return result;
  } });
  assert.deepEqual(frozen.errors, []);
  assert.equal(frozen.sdkMatrix.include.length, 10);
  assert.deepEqual(frozen.sdkMatrix.include.filter(entry => entry.os === "windows-latest" && entry.backend === "pi-rpc-aimock").map(entry => entry.phase), ["behavior", "vendor"]);
});

test("SDK candidate rewrites stay in the disposable checkout and preserve package releases", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "oar-sdk-candidate-test-"));
  try {
    for (const relative of ["package.json", "packages/oar/package.json", "packages/cli/package.json"]) {
      mkdirSync(path.dirname(path.join(directory, relative)), { recursive: true });
      copyFileSync(new URL(`../../${relative}`, import.meta.url), path.join(directory, relative));
    }
    const versions = Object.fromEntries(["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-durable", "@earendil-works/chord"].map(name => [name, { version: "9.0.0" }]));
    versions.undici = { version: "9.1.0" };
    const original = JSON.parse(readFileSync(path.join(directory, "packages/oar/package.json")));
    rewriteSdkManifests("pi", versions, directory);
    const changed = JSON.parse(readFileSync(path.join(directory, "packages/oar/package.json")));
    assert.equal(changed.version, original.version);
    assert.equal(changed.dependencies["@earendil-works/pi-ai"], "9.0.0");
    assert.equal(changed.dependencies.undici, "9.1.0");
    assert.equal(changed.peerDependencies["@cursor/sdk"], original.peerDependencies["@cursor/sdk"]);
    const root = JSON.parse(readFileSync(path.join(directory, "package.json")));
    assert.equal(root.devDependencies["@earendil-works/pi-ai-durable"], "npm:@earendil-works/pi-ai@9.0.0");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

for (const candidate of [false, true]) for (const mismatch of [false, true]) test(`real offline npm install publishes only a verified native version (candidate=${candidate}, mismatch=${mismatch})`, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "oar-runtime install-test-"));
  try {
    const fixture = path.join(directory, "package");
    mkdirSync(fixture);
    writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ name: "oar-ci-fixture", version: "1.2.3", bin: { "oar-ci-fixture": "cli.cjs" } }));
    writeFileSync(path.join(fixture, "cli.cjs"), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(mismatch ? "9.8.7" : "1.2.3")});\n`);
    const home = path.join(directory, "home");
    mkdirSync(home);
    const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", directory, fixture], { env: isolatedEnvironment(home), encoding: "utf8", timeout: 30_000 });
    assert.equal(packed.status, 0, packed.stderr);
    const bytes = readFileSync(path.join(directory, "oar-ci-fixture-1.2.3.tgz"));
    let downloads = 0;
    await serverFor((_request, response) => { downloads++; response.end(bytes); }, async url => {
      const manifestFile = path.join(directory, "pins.json");
      writeFileSync(manifestFile, JSON.stringify({ schemaVersion: 1, ...(candidate ? { baselineSha256: readManifest().sha256 } : {}), runtimes: { fixture: {
        package: "oar-ci-fixture", version: "1.2.3", command: "oar-ci-fixture", env: "OAR_CI_FIXTURE_BIN", dist: { url, integrity: hash(bytes) },
      } } }));
      const githubEnv = path.join(directory, "github-env");
      const githubPath = path.join(directory, "github-path");
      const reportDirectory = path.join(directory, "reports");
      const install = () => installRuntime("fixture", manifestFile, { directory, githubEnv, githubPath, reportDirectory });
      if (mismatch) {
        await assert.rejects(install(), /Installed native version differs/u);
        assert.equal(existsSync(githubEnv), false);
        assert.equal(existsSync(githubPath), false);
      } else {
        const report = await install();
        assert.equal(report.actualVersion, "1.2.3");
        assert.equal(report.status, "verified");
        const published = readFileSync(githubEnv, "utf8");
        assert.match(published, /^OAR_CI_FIXTURE_BIN=/u);
        assert.equal(published.includes("OAR_CI_CANDIDATE_VERSION=1.2.3\n"), candidate);
      }
      const report = JSON.parse(readFileSync(path.join(reportDirectory, readdirSync(reportDirectory)[0])));
      assert.equal(report.status, mismatch ? "failed" : "verified");
      assert.equal(downloads, 1, "Native version mismatch must not retry the download");
      assert.equal(report.downloadAttempts.length, 1);
      assert.equal(report.downloadAttempts[0].status, "verified");
      assert.equal(report.manifestSha256, readManifest(manifestFile).sha256);
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

// Exercise the installed Vitest API as well as pure matching: a new reporter
// must preserve the child's exit status and keep unrelated failures visible.
async function candidateFixture({ key = "kimi-aimock", version = "2.6.3", source, file = "mcp-servers-acp.vendor.test.ts" }) {
  const directory = mkdtempSync(path.join(tmpdir(), "oar-candidate-reporter-"));
  const { fileURLToPath, pathToFileURL } = await import("node:url");
  const { candidateSummary } = await import("./runtime-candidate-summary.mjs");
  try {
    mkdirSync(path.join(directory, "sea-trial/vendor"), { recursive: true });
    const vitestImport = pathToFileURL(require.resolve("vitest").replace(/index\.cjs$/u, "dist/index.js")).href;
    writeFileSync(path.join(directory, "sea-trial/vendor", file), `import { beforeAll, describe, expect, test } from ${JSON.stringify(vitestImport)};\n${source}`);
    const config = path.join(directory, "vitest.config.mjs");
    writeFileSync(config, 'export default { test: { include: ["sea-trial/vendor/*.test.ts"], maxWorkers: 1 } };');
    const reporter = fileURLToPath(new URL("runtime-candidate-reporter.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs"), "run", "--root", directory,
      "--config", config, "--reporter", "default", "--reporter", reporter], {
      cwd: directory, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, OAR_TEST: key, OAR_CI_CANDIDATE_VERSION: version,
        OAR_CANDIDATE_TEST_STEP: "vendor", OAR_TRIAL_RUN_DIR: directory },
    });
    assert.ok(!result.error, result.stdout + result.stderr);
    assert.ok(existsSync(path.join(directory, "candidate-tests.json")), result.stdout + result.stderr);
    const raw = readFileSync(path.join(directory, "candidate-tests.json"), "utf8");
    const report = JSON.parse(raw);
    const summary = candidateSummary({ key, version, os: "fixture", report,
      steps: { vendor: { outcome: result.status === 0 ? "success" : "failure" } } });
    return { status: result.status, report, raw, summary, output: result.stdout + result.stderr };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

const mcpFailure = `describe("kimi-aimock mcpServers", () => {
  test("a stdio and an http server attach, the agent calls both, and a resume attaches them again", () => {
    expect({ opened: ["mcp__echo__echo", "mcp__remote__echo"], resumedWithout: ["mcp__echo__echo", "mcp__remote__echo"] })
      .toEqual({ opened: ["mcp__echo__echo", "mcp__remote__echo"], resumedWithout: [] });
  });
});`;
const workspaceFailure = `describe("Kimi native Web skill inventory", () => {
  test("discovery preserves an existing user workspace with the same root", () => {
    expect("wm_01234567-89ab-cdef-0123-456789abcdef").toBe("wm_11111111-89ab-cdef-0123-456789abcdef");
  });
});`;

test("real Vitest keeps known and new failures red without copying assertion secrets", async () => {
  const result = await candidateFixture({ source: mcpFailure + '\ntest("new failure", () => { throw new Error("synthetic-private-error"); });' });
  assert.equal(result.status, 1, result.output);
  assert.equal(result.report.complete, true);
  assert.equal(result.report.failures.length, 2);
  assert.equal(result.report.failures.filter(failure => failure.known).length, 1, result.raw);
  assert.match(result.summary, /KNOWN.*issue #899/u);
  assert.match(result.summary, /NEW \/ UNCLASSIFIED.*new failure/u);
  assert.doesNotMatch(result.raw, /synthetic-private-error|mcp__echo__echo/u);
});

test("real Vitest recognizes both observed workspace versions and refuses an unobserved one", async () => {
  for (const version of ["2.6.2", "2.6.3", "2.6.4"]) {
    const result = await candidateFixture({ key: "kimi-login", version, file: "kimi-skills.vendor.test.ts", source: workspaceFailure });
    assert.equal(result.status, 1, result.output);
    assert.equal(result.report.failures.length, 1);
    assert.equal(!!result.report.failures[0].known, version !== "2.6.4", result.raw);
    assert.doesNotMatch(result.raw, /wm_01234567/u);
  }
});

test("changed assertions and additional hook failures remain unclassified", async () => {
  const changed = await candidateFixture({ source: mcpFailure.replace('resumedWithout: ["mcp__echo__echo", "mcp__remote__echo"]', 'resumedWithout: ["mcp__echo__ echo", "mcp__remote__echo"]') });
  assert.equal(changed.status, 1, changed.output);
  assert.equal(changed.report.failures[0].known, undefined);
  const hooked = await candidateFixture({ source: mcpFailure + '\ndescribe("broken setup", () => { beforeAll(() => { throw new Error("synthetic-hook-secret"); }); test("unreached", () => {}); });' });
  assert.equal(hooked.status, 1, hooked.output);
  assert.equal(hooked.report.failures.filter(failure => failure.known).length, 1);
  assert.ok(hooked.report.unclassifiedErrors > 0, hooked.raw);
  assert.match(hooked.summary, /NEW \/ UNCLASSIFIED.*collection, hook or unhandled errors/u);
  assert.doesNotMatch(hooked.raw, /synthetic-hook-secret/u);
  const passed = await candidateFixture({ source: 'test("pass", () => expect(true).toBe(true));' });
  assert.equal(passed.status, 0, passed.output);
  assert.equal(passed.report.failures.length, 0);
});

test("classification requires the observed runtime, file, case and one exact assertion", async () => {
  const { knownCandidateFailure, mcpCase } = await import("./runtime-candidate-failures.mjs");
  const tools = ["mcp__echo__echo", "mcp__remote__echo"];
  const failure = { key: "kimi-aimock", version: "2.6.2", file: "sea-trial/vendor/mcp-servers-acp.vendor.test.ts", name: mcpCase,
    errors: [{ name: "AssertionError", expected: JSON.stringify({ opened: tools, resumedWithout: [] }), actual: JSON.stringify({ opened: tools, resumedWithout: tools }) }] };
  assert.ok(knownCandidateFailure(failure));
  for (const change of [{ key: "other" }, { file: "other.ts" }, { name: "other case" }, { errors: [] },
    { errors: [...failure.errors, ...failure.errors] }, { errors: [{ ...failure.errors[0], name: "Error" }] },
    { errors: [{ ...failure.errors[0], actual: failure.errors[0].actual.replace("mcp__echo__echo", "mcp__other__tool") }] }]) {
    assert.equal(knownCandidateFailure({ ...failure, ...change }), undefined);
  }
});

test("summary preserves setup, cancellation and incomplete-report failures beside a known test", async () => {
  const { candidateSummary } = await import("./runtime-candidate-summary.mjs");
  const { kimiIssue } = await import("./runtime-candidate-failures.mjs");
  const report = { schemaVersion: 1, key: "kimi-aimock", version: "2.6.3", step: "vendor", complete: true,
    failures: [{ file: "fixture.ts", name: "known", known: { issue: kimiIssue } }], unclassifiedErrors: 0 };
  const input = { key: report.key, version: report.version, os: "fixture", report,
    steps: { vendor: { outcome: "failure" }, dependencies: { outcome: "failure" }, native_behavior: { outcome: "failure" }, upload_candidate: { outcome: "failure" } } };
  const summary = candidateSummary(input);
  assert.match(summary, /KNOWN.*issue #899/u);
  for (const step of ["dependencies", "native_behavior", "upload_candidate"]) assert.match(summary, new RegExp(`NEW / UNCLASSIFIED.*Step ${step}`, "u"));
  assert.doesNotMatch(summary, /Step vendor/u);
  for (const other of [undefined, { ...report, complete: false }, { ...report, version: "2.6.2" }, { ...report, failures: [] }]) {
    assert.match(candidateSummary({ ...input, report: other }), /NEW \/ UNCLASSIFIED.*Step vendor/u);
  }
  assert.match(candidateSummary({ ...input, steps: { vendor: { outcome: "cancelled" } } }), /NEW \/ UNCLASSIFIED.*Step vendor: cancelled/u);
});
