import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { expect, test } from "vitest";
import { defaultRuntimes } from "../packages/oar/src/index.js";
import { parseJson } from "../packages/oar/src/shared/json.js";
import { compareSemver, parseSemver } from "../packages/oar/src/shared/semver.js";
import {
  SUGGESTED_VERSIONS_URL,
  checkSuggestedVersion,
  parseSuggestedVersions,
  suggestedVersions,
  type SuggestedVersionsManifest,
} from "../packages/oar/src/suggested-versions.js";

test("bundled suggestedVersions matches packages/oar/assets/suggested-versions.json and stays frozen", () => {
  const rawText = readFileSync(new URL("../packages/oar/assets/suggested-versions.json", import.meta.url), "utf8");
  const parsed = parseSuggestedVersions(parseJson(rawText));
  expect(parsed).toEqual(suggestedVersions);
  expect(Object.isFrozen(suggestedVersions)).toBe(true);
  expect(Object.isFrozen(suggestedVersions.runtimes)).toBe(true);
  expect(Object.isFrozen(suggestedVersions.runtimes.codex)).toBe(true);
  expect(SUGGESTED_VERSIONS_URL).toBe(
    "https://raw.githubusercontent.com/botiverse/oar/main/packages/oar/assets/suggested-versions.json",
  );
});

test("every runtime entry names a built-in runtime, valid semver above its hard floor, and metadata", () => {
  for (const [runtimeId, entry] of Object.entries(suggestedVersions.runtimes)) {
    const runtime = defaultRuntimes.require(runtimeId);
    expect(parseSemver(entry.version)).not.toBeNull();
    expect(entry.reason.trim().length).toBeGreaterThan(0);
    expect(entry.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(entry.evidence?.startsWith("https://")).toBe(true);
    if (runtime.minVersion !== undefined) {
      const order = compareSemver(entry.version, runtime.minVersion);
      expect(order).not.toBeNull();
      expect(order ?? -1).toBeGreaterThanOrEqual(0);
    }
  }
});

test("checkSuggestedVersion returns upgrade advice when installedVersion is strictly below suggestedMinVersion", () => {
  expect(checkSuggestedVersion("codex", "0.160.0")).toEqual({
    runtime: "codex",
    installedVersion: "0.160.0",
    suggestedMinVersion: suggestedVersions.runtimes.codex?.version,
    reason: suggestedVersions.runtimes.codex?.reason,
  });
  expect(checkSuggestedVersion("codex", "0.166.0-rc.1")).toEqual({
    runtime: "codex",
    installedVersion: "0.166.0-rc.1",
    suggestedMinVersion: suggestedVersions.runtimes.codex?.version,
    reason: suggestedVersions.runtimes.codex?.reason,
  });
});

test("checkSuggestedVersion extracts semver from CLI version banners and treats met thresholds as satisfied", () => {
  expect(checkSuggestedVersion("codex", "codex-cli 0.160.0")).toEqual({
    runtime: "codex",
    installedVersion: "0.160.0",
    suggestedMinVersion: suggestedVersions.runtimes.codex?.version,
    reason: suggestedVersions.runtimes.codex?.reason,
  });
  expect(checkSuggestedVersion("claude", "2.1.283 (Claude Code)")).toEqual({
    runtime: "claude",
    installedVersion: "2.1.283",
    suggestedMinVersion: suggestedVersions.runtimes.claude?.version,
    reason: suggestedVersions.runtimes.claude?.reason,
  });
  expect(checkSuggestedVersion("codex", "0.166.0")).toBeNull();
  expect(checkSuggestedVersion("codex", "0.172.0")).toBeNull();
  expect(checkSuggestedVersion("claude", "2.1.321 (Claude Code)")).toBeNull();
});

test("checkSuggestedVersion returns null for missing/unreadable versions, unlisted runtimes, and prototype keys", () => {
  expect(checkSuggestedVersion("codex", undefined)).toBeNull();
  expect(checkSuggestedVersion("codex", "unknown")).toBeNull();
  expect(checkSuggestedVersion("grok", "1.0.70")).toBeNull();
  expect(checkSuggestedVersion("toString", "0.1.0")).toBeNull();
});

test("checkSuggestedVersion evaluates against an explicit remote manifest when supplied", () => {
  const remote: SuggestedVersionsManifest = {
    schemaVersion: 1,
    updatedAt: "2026-11-27",
    runtimes: {
      grok: { version: "1.1.0", reason: "Supports Grok 5" },
    },
  };
  expect(checkSuggestedVersion("grok", "1.0.70", remote)).toEqual({
    runtime: "grok",
    installedVersion: "1.0.70",
    suggestedMinVersion: "1.1.0",
    reason: "Supports Grok 5",
  });
  expect(checkSuggestedVersion("codex", "0.160.0", remote)).toBeNull();
});

test("parseSuggestedVersions accepts valid manifests, ignores extra fields, and drops invalid individual runtime rows", () => {
  const parsed = parseSuggestedVersions({
    schemaVersion: 1,
    updatedAt: "2026-11-26",
    futureNote: "ignored",
    runtimes: {
      codex: {
        version: "0.166.0",
        reason: "Supports GPT-6.2 models",
        extraField: true,
      },
      badSemver: { version: "latest", reason: "nope" },
      emptyReason: { version: "1.0.0", reason: "   " },
      notAnObject: "1.0.0",
      "   ": { version: "1.0.0", reason: "blank runtime key" },
    },
  });
  expect(parsed).toEqual({
    schemaVersion: 1,
    updatedAt: "2026-11-26",
    runtimes: {
      codex: {
        version: "0.166.0",
        reason: "Supports GPT-6.2 models",
      },
    },
  });
});

test("parseSuggestedVersions returns null on malformed root payloads", () => {
  expect(parseSuggestedVersions(null)).toBeNull();
  expect(parseSuggestedVersions([])).toBeNull();
  expect(parseSuggestedVersions({ schemaVersion: 2, updatedAt: "2026-11-26", runtimes: {} })).toBeNull();
  expect(parseSuggestedVersions({ schemaVersion: 1, updatedAt: "", runtimes: {} })).toBeNull();
  expect(parseSuggestedVersions({ schemaVersion: 1, updatedAt: "2026-11-26", runtimes: [] })).toBeNull();
});

test("the suggested-versions entry bundles for browsers with no externals or Node imports", async () => {
  const result = await build({
    entryPoints: ["packages/oar/src/suggested-versions.ts"],
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    metafile: true,
    plugins: [{
      name: "no-node",
      setup(builder) {
        // oxlint-disable-next-line require-unicode-regexp
        builder.onResolve({ filter: /^node:/ }, (args) => ({
          errors: [{ text: `Node import ${args.path} from ${args.importer}` }],
        }));
      },
    }],
  });
  expect(Object.values(result.metafile.outputs).flatMap((output) => output.imports)).toEqual([]);
  expect(Object.keys(result.metafile.inputs).toSorted()).toEqual([
    "packages/oar/src/shared/semver.ts",
    "packages/oar/src/suggested-versions.generated.ts",
    "packages/oar/src/suggested-versions.ts",
  ]);
  expect(result.outputFiles[0]?.text).toContain("checkSuggestedVersion");
});
