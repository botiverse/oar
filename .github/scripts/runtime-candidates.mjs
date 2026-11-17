import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { exactVersion, jsonResponse, nativeVersion, packageDist, readManifest, registryUrl } from "./runtime-common.mjs";

const platforms = ["ubuntu-latest", "macos-latest", "windows-latest"];

export async function freezeCandidates({ baseline = readManifest(), request = jsonResponse, stableVersion } = {}) {
  const result = { schemaVersion: 1, generatedAt: new Date().toISOString(), baselineSha256: baseline.sha256,
    runtimes: {}, sdks: {}, excluded: [], unchanged: [], errors: [], matrix: { include: [] }, sdkMatrix: { include: [] } };
  const metadata = new Map();
  const resolve = (name, selector = "latest") => {
    const key = `${name}@${selector}`;
    if (!metadata.has(key)) metadata.set(key, request(registryUrl(name, selector)));
    return metadata.get(key);
  };
  for (const [key, accepted] of Object.entries(baseline.manifest.runtimes)) {
    // Floors and known replay boundaries need separate upgrade evidence.
    // Do not turn their intentional lag into a permanently red daily run.
    if (!accepted.suite || accepted.policy === "minimum" || accepted.policy === "replay") {
      result.excluded.push({ key, policy: accepted.policy, version: accepted.version });
      continue;
    }
    try {
      const candidate = structuredClone(accepted);
      if (accepted.archives) {
        const versions = [];
        for (const [platform, archive] of Object.entries(accepted.archives)) {
          const latest = await request(archive.source);
          assert.ok(exactVersion(latest.version), `Invalid archive version for ${platform}`);
          assert.ok(typeof latest.url === "string" && /^https:\/\//u.test(latest.url), `Invalid archive URL for ${platform}`);
          assert.match(latest.sha512, /^[a-f0-9]{128}$/u);
          versions.push(latest.version);
          candidate.archives[platform] = { ...latest, source: archive.source };
        }
        assert.equal(new Set(versions).size, 1, "Platform manifests disagree on the candidate version");
        candidate.version = versions[0];
      } else {
        let selector = "latest";
        if (accepted.channel) {
          if (stableVersion) selector = await stableVersion(accepted.channel);
          else {
            const response = await fetch(accepted.channel, { signal: AbortSignal.timeout(30_000) });
            assert.ok(response.ok, `Release channel: HTTP ${response.status}`);
            selector = nativeVersion(await response.text());
          }
        }
        assert.ok(selector === "latest" || exactVersion(selector), `Invalid release channel version for ${key}`);
        const latest = await resolve(accepted.package, selector);
        assert.ok(exactVersion(latest.version), `Invalid candidate version for ${key}`);
        if (selector !== "latest") assert.equal(latest.version, selector, "Registry disagrees with the frozen release channel");
        candidate.version = latest.version;
        candidate.dist = packageDist(latest, accepted.package, latest.version);
      }
      candidate.acceptedVersion = accepted.version;
      result.runtimes[key] = candidate;
      if (candidate.version === accepted.version) result.unchanged.push(key);
      else for (const os of accepted.platforms) result.matrix.include.push({ key, os, suite: accepted.suite });
    } catch (error) { result.errors.push({ key, error: error.message }); }
  }

  const workspace = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url)));
  for (const [group, names] of Object.entries({
    cursor: ["@cursor/sdk"],
    pi: ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-durable", "@earendil-works/chord"],
  })) {
    try {
      const packages = {};
      for (const name of names) {
        const latest = await resolve(name);
        assert.ok(exactVersion(latest.version), `Invalid SDK version for ${name}`);
        packages[name] = { version: latest.version, acceptedVersion: workspace.devDependencies[name],
          dist: packageDist(latest, name, latest.version) };
        if (name === "@earendil-works/pi-coding-agent") {
          const undiciVersion = latest.dependencies?.undici;
          assert.ok(exactVersion(undiciVersion), "Pi candidate must declare an exact undici dependency");
          const undici = await resolve("undici", undiciVersion);
          packages.undici = { version: undiciVersion, acceptedVersion: workspace.devDependencies.undici,
            dist: packageDist(undici, "undici", undiciVersion) };
        }
      }
      const changed = Object.values(packages).some(entry => entry.version !== entry.acceptedVersion);
      result.sdks[group] = { packages, changed };
      if (changed) for (const os of platforms) {
        if (group === "cursor") result.sdkMatrix.include.push({ group, os, backend: "cursor-skills", phase: "all" });
        else for (const backend of ["pi-aimock", "pi-durable-aimock", "pi-rpc-aimock"]) {
          const phases = os === "windows-latest" && backend === "pi-rpc-aimock" ? ["behavior", "vendor"] : ["all"];
          for (const phase of phases) result.sdkMatrix.include.push({ group, os, backend, phase });
        }
      }
    } catch (error) { result.errors.push({ key: `sdk-${group}`, error: error.message }); }
  }
  return result;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [directory, ...extra] = process.argv.slice(2);
  assert.ok(directory && extra.length === 0, "Usage: runtime-candidates.mjs <output-directory>");
  mkdirSync(directory, { recursive: true });
  const result = await freezeCandidates();
  writeFileSync(path.join(directory, "candidates.json"), `${JSON.stringify(result, null, 2)}\n`);
  const summary = ["# Frozen runtime candidates", "", `Resolved at ${result.generatedAt}; baseline ${result.baselineSha256}.`, "",
    "No baseline is promoted by this workflow. Bump PRs require the additional version-specific probes listed in experiments/runtime-versions.ts and maintainer review.", "",
    "| Entry | Accepted | Candidate |", "| --- | --- | --- |",
    ...Object.entries(result.runtimes).map(([key, pin]) => `| ${key} | ${pin.acceptedVersion} | ${pin.version} |`),
    ...Object.entries(result.sdks).flatMap(([group, sdk]) => Object.entries(sdk.packages).map(([name, pin]) => `| SDK ${group}: ${name} | ${pin.acceptedVersion} | ${pin.version} |`)), "",
    ...result.excluded.map(entry => `- Excluded ${entry.key} (${entry.policy}, ${entry.version}); requires a separate upgrade check.`), "",
    ...result.errors.map(error => `- Discovery failed for ${error.key}: ${error.error}`), ""].join("\n");
  writeFileSync(path.join(directory, "summary.md"), summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, [
    `matrix=${JSON.stringify(result.matrix)}`, `has-candidates=${result.matrix.include.length > 0}`,
    `sdk-matrix=${JSON.stringify(result.sdkMatrix)}`, `has-sdk-candidates=${result.sdkMatrix.include.length > 0}`, "",
  ].join("\n"));
  process.stdout.write(summary);
  if (result.errors.length) process.exitCode = 1;
}
