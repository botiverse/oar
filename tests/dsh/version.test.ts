import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { dshInstallation } from "../../packages/oar/src/runtimes/dsh/installation.js";
import { clearInstallationCache } from "../../packages/oar/src/shared/installation.js";
import { DSH_MINIMUM_VERSION, compareSemver, dshVersionRefusal } from "../../packages/oar/src/runtimes/dsh/version.js";
import { fakeAgentBinary } from "../fixtures/process-tree.js";

const dir = mkdtempSync(path.join(tmpdir(), "oar-dsh-version-"));
const fake = fakeAgentBinary(dir, [path.resolve(import.meta.dirname, "../fixtures/fake-dsh.mjs")]);
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

test("the floor is the tested release", () => {
  expect(DSH_MINIMUM_VERSION).toBe("0.2.1-rc.5");
});

test.each([
  ["0.2.1-rc.5", 0], ["0.2.1-rc.10", 1], ["0.2.1", 1], ["0.2.2-alpha.2", 1], ["0.2.2-rc.1", 1], ["0.3.0", 1], ["1.0.0-alpha.1", 1],
  ["0.2.1-rc.4", -1], ["0.2.1-beta.9", -1], ["0.2.1-alpha.4", -1], ["0.2.1-rc", -1], ["0.2.0", -1], ["0.1.99", -1],
])("%s against the floor by semver prerelease ordering", (version, order) => {
  expect(Math.sign(compareSemver(version, DSH_MINIMUM_VERSION) ?? Number.NaN)).toBe(order);
});

test("numeric identifiers order below alphanumeric ones, build metadata is ignored", () => {
  expect(compareSemver("1.0.0-1", "1.0.0-a")).toBeLessThan(0);
  expect(compareSemver("1.0.0-a", "1.0.0-a.0")).toBeLessThan(0);
  expect(compareSemver("1.0.0+build", "1.0.0")).toBe(0);
  expect(compareSemver("not-a-version", "1.0.0")).toBeNull();
});

test("a refusal names the real version; an unreadable one is never assumed supported", () => {
  expect(dshVersionRefusal("0.2.1-rc.5")).toBeNull();
  expect(dshVersionRefusal("0.2.2-alpha.2")).toBeNull();
  expect(dshVersionRefusal("0.2.1-rc.4")).toBe("DSH 0.2.1-rc.4 is below the supported floor; OAR requires 0.2.1-rc.5 or later");
  expect(dshVersionRefusal("nightly")).toBe('DSH reported the unreadable version "nightly"; OAR requires 0.2.1-rc.5 or later');
  expect(dshVersionRefusal(undefined)).toBe("DSH did not report a version; OAR requires 0.2.1-rc.5 or later");
});

// The fake prints whatever FAKE_DSH_VERSION says from one unchanged file, which a real binary cannot;
// forget each answer so every probe runs it.
async function probe(env: Record<string, string>): ReturnType<typeof dshInstallation> {
  clearInstallationCache();
  return dshInstallation({ env });
}

test("installation is unsupported below the floor, available at it, and pins exclusively through OAR_DSH_BIN", async () => {
  expect(await probe({ OAR_DSH_BIN: fake, FAKE_DSH_VERSION: "0.2.1-rc.4" })).toEqual({ kind: "unsupported", code: "version_unsupported", via: "executable", command: fake, installedVersion: "0.2.1-rc.4", requiredVersion: "0.2.1-rc.5", reason: "DSH 0.2.1-rc.4 is below the supported floor; OAR requires 0.2.1-rc.5 or later" });
  expect(await probe({ OAR_DSH_BIN: fake, FAKE_DSH_VERSION: "0.2.1-rc.5" })).toEqual({ kind: "available", via: "executable", command: fake, version: "0.2.1-rc.5" });
  expect(await probe({ OAR_DSH_BIN: fake, FAKE_DSH_VERSION: "0.2.2-alpha.2" })).toMatchObject({ kind: "available", version: "0.2.2-alpha.2" });
  expect(await dshInstallation({ env: { OAR_DSH_BIN: path.join(dir, "missing") } })).toEqual({ kind: "not_found" });
});

test("directory grants follow the installed DSH version and platform", async () => {
  const { dshDirectoryRefusal } = await import("../../packages/oar/src/runtimes/dsh/options.js");
  expect(dshDirectoryRefusal("0.2.2-rc.1", "linux").additionalDirectories).toContain("0.2.2-rc.3");
  expect(dshDirectoryRefusal("0.2.2-rc.3", "darwin")).toEqual({});
  expect(dshDirectoryRefusal("0.2.2-rc.5", "linux")).toEqual({});
  expect(dshDirectoryRefusal("0.2.2-rc.5", "win32").additionalDirectories).toContain("shell");
});
