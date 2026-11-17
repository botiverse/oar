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

for (const mismatch of [false, true]) test(`real offline npm install publishes only a verified native version (mismatch=${mismatch})`, async () => {
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
    await serverFor((_request, response) => response.end(bytes), async url => {
      const manifestFile = path.join(directory, "pins.json");
      writeFileSync(manifestFile, JSON.stringify({ schemaVersion: 1, runtimes: { fixture: {
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
        assert.match(readFileSync(githubEnv, "utf8"), /^OAR_CI_FIXTURE_BIN=/u);
      }
      const report = JSON.parse(readFileSync(path.join(reportDirectory, readdirSync(reportDirectory)[0])));
      assert.equal(report.status, mismatch ? "failed" : "verified");
      assert.equal(report.manifestSha256, readManifest(manifestFile).sha256);
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
