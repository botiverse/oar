import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const baselineFile = new URL("../runtime-versions.json", import.meta.url);
const number = "(?:0|[1-9][0-9]*)";
const prerelease = `(?:${number}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
const versionSource = `${number}\\.${number}\\.${number}(?:-${prerelease}(?:\\.${prerelease})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?`;

export function exactVersion(value) {
  return typeof value === "string" && value.trim() === value && new RegExp(`^${versionSource}$`, "u").test(value);
}

export function readManifest(file = baselineFile) {
  const bytes = readFileSync(file);
  const manifest = JSON.parse(bytes);
  assert.equal(manifest?.schemaVersion, 1, "Unsupported runtime-versions.json schemaVersion");
  assert.ok(manifest.runtimes && typeof manifest.runtimes === "object" && !Array.isArray(manifest.runtimes), "Missing runtime pins");
  return { manifest, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export function runtimePin(manifest, key) {
  assert.ok(Object.hasOwn(manifest.runtimes, key), `No accepted runtime pin for ${key}`);
  const entry = manifest.runtimes[key];
  assert.ok(entry && typeof entry === "object" && !Array.isArray(entry), `Invalid runtime pin for ${key}`);
  assert.ok(exactVersion(entry.version), `Expected an exact npm version for ${key}`);
  return entry;
}

export function npmSpec(entry, key) {
  assert.ok(typeof entry.package === "string" && entry.package.trim() === entry.package
    && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(entry.package), `Expected an npm package name for ${key}`);
  assert.ok(exactVersion(entry.version), `Expected an exact npm version for ${key}`);
  return `${entry.package}@${entry.version}`;
}

// Version banners differ between vendors. Require exactly one distinct complete
// version token, then compare it exactly; prefixes and prereleases cannot pass.
export function nativeVersion(output) {
  const versions = [...new Set([...output.matchAll(new RegExp(`(?<![0-9A-Za-z.+-])v?(${versionSource})(?![0-9A-Za-z.+-])`, "gu"))].map(match => match[1]))];
  assert.equal(versions.length, 1, "Native --version must report one unambiguous version");
  return versions[0];
}

export async function jsonResponse(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  assert.ok(response.ok, `${url}: HTTP ${response.status}`);
  return response.json();
}

export function registryUrl(name, version) {
  return `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
}

export function packageDist(metadata, name, version) {
  assert.equal(metadata.name, name, "Registry package name mismatch");
  assert.equal(metadata.version, version, "Registry package version mismatch");
  const { tarball, integrity, shasum } = metadata.dist ?? {};
  assert.ok(typeof tarball === "string" && /^https?:\/\//u.test(tarball), "Missing package tarball URL");
  const digest = integrity ?? (typeof shasum === "string" && /^[a-f0-9]{40}$/u.test(shasum)
    ? `sha1-${Buffer.from(shasum, "hex").toString("base64")}` : undefined);
  assert.ok(typeof digest === "string" && /^(?:sha512|sha384|sha256|sha1)-[A-Za-z0-9+/]+=*$/u.test(digest), "Missing supported package integrity");
  return { url: tarball, integrity: digest };
}

export async function downloadVerified(dist) {
  const response = await fetch(dist.url, { signal: AbortSignal.timeout(120_000) });
  assert.ok(response.ok, `Artifact download: HTTP ${response.status} from ${dist.url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const [algorithm, expected] = dist.integrity.split("-");
  assert.ok(["sha512", "sha384", "sha256", "sha1"].includes(algorithm) && expected, "Unsupported artifact integrity");
  assert.equal(createHash(algorithm).update(bytes).digest("base64"), expected, "Artifact integrity mismatch");
  return bytes;
}
