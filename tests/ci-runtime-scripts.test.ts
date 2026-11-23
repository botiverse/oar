import { globSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { runExecutable } from "../packages/oar/src/shared/executable/run.js";
import { asRecord, parseJson } from "../packages/oar/src/shared/json.js";
import path from "node:path";
import { expect, test } from "vitest";
import { acceptedPiVersions, checkPiManifestConsistency, satisfiesPublishedRange } from "./fixtures/clean-install-pins.js";

function fixtureEnvironment(directory: string): NodeJS.ProcessEnv {
  const inherited = Object.entries(process.env).filter(([key]) => !/^(?:temp|tmp|tmpdir|runner_temp|npm_config_cache)$/iu.test(key));
  return { ...Object.fromEntries(inherited), TEMP: directory, TMP: directory, TMPDIR: directory, RUNNER_TEMP: directory,
    npm_config_cache: path.join(directory, "cache") };
}

test("CI candidate scripts preserve failures and install only the frozen local fixture", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "oar-ci-"));
  try {
    const result = await runExecutable(process.execPath, ["--test", "--test-reporter=tap", ".github/scripts/runtime-ci.test.mjs"], {
      timeoutMs: 90_000, env: fixtureEnvironment(directory),
    });
    if (!result.ok) {
      const reports = globSync("oar-runtime install-test-*/reports/*.json", { cwd: directory });
      const stages = reports.map(file => {
        const raw = readFileSync(path.join(directory, file), "utf8");
        return asRecord(parseJson(raw))?.stage;
      });
      throw new Error(`CI candidate scripts failed: ${JSON.stringify(result.diagnostics)}, active installer stages ${JSON.stringify(stages)}\n${result.stdout}\n${result.stderr}`);
    }
    expect(result.stdout).toMatch(/# fail 0/u);
  } finally { rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}, 100_000);

test("the gate derives Pi and undici pins from the actual accepted workspace graph", () => {
  const versions = acceptedPiVersions(path.resolve("."));
  expect(Object.keys(versions)).toEqual(expect.arrayContaining([
    "@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-durable", "@earendil-works/chord", "undici",
  ]));
  expect(Object.values(versions).every(version => /^\d+\.\d+\.\d+$/u.test(version))).toBe(true);
});

test.each([
  ["1.5.2", "^1.5.2", true], ["1.6.0", "^1.5.2", true], ["2.0.0", "^1.5.2", false],
  ["1.5.1", "^1.5.2", false], ["1.5.3", "~1.5.2", true], ["1.6.0", "~1.5.2", false],
  ["0.2.1", "^0.2.0", true], ["0.3.0", "^0.2.0", false], ["0.0.2", "^0.0.1", false],
  ["1.5.2", "1.5.2", true], ["1.5.3", "1.5.2", false],
])("accepted version %s satisfies published %s: %s", (version, range, expected) => {
  expect(satisfiesPublishedRange(version, range)).toBe(expected);
});

test("an unknown published range cannot silently admit a baseline", () => {
  expect(() => satisfiesPublishedRange("1.5.2", ">=1.0.0")).toThrow("Unsupported Pi baseline/range");
});

function sampleManifests(overrides: {
  readonly oarOptional?: Record<string, string>;
  readonly oarPeers?: Record<string, string>;
  readonly oarUndici?: string;
  readonly cliDeps?: Record<string, string>;
  readonly piUndici?: string;
} = {}) {
  return {
    oar: {
      dependencies: { undici: overrides.oarUndici ?? "8.12.3" },
      optionalDependencies: { "@earendil-works/pi-ai": "~1.5.2", "@earendil-works/pi-coding-agent": "~1.5.2", ...overrides.oarOptional },
      peerDependencies: { "@earendil-works/pi-durable": "~1.5.2", "@earendil-works/chord": "~1.5.2", ...overrides.oarPeers },
    },
    cli: { dependencies: { "@earendil-works/pi-ai": "~1.5.2", "@earendil-works/pi-coding-agent": "~1.5.2", ...overrides.cliDeps } },
    pi: { dependencies: { undici: overrides.piUndici ?? "8.12.3" } },
  };
}

test("Pi manifest consistency accepts matching tilde or exact ranges with matching exact undici", () => {
  const tilde = sampleManifests();
  expect(() => { checkPiManifestConsistency(tilde.oar, tilde.cli, tilde.pi); }).not.toThrow();
  const exact = sampleManifests({
    oarOptional: { "@earendil-works/pi-ai": "1.6.0", "@earendil-works/pi-coding-agent": "1.6.0" },
    oarPeers: { "@earendil-works/pi-durable": "1.6.0", "@earendil-works/chord": "1.6.0" },
    cliDeps: { "@earendil-works/pi-ai": "1.6.0", "@earendil-works/pi-coding-agent": "1.6.0" },
    oarUndici: "8.12.4",
    piUndici: "8.12.4",
  });
  expect(() => { checkPiManifestConsistency(exact.oar, exact.cli, exact.pi); }).not.toThrow();
});

test("Pi manifest consistency rejects mismatched ranges, caret ranges, and mismatched undici", () => {
  const splitOar = sampleManifests({ oarOptional: { "@earendil-works/pi-coding-agent": "^1.5.2" } });
  expect(() => { checkPiManifestConsistency(splitOar.oar, splitOar.cli, splitOar.pi); }).toThrow(/Pi family range mismatch/u);
  const splitCli = sampleManifests({ cliDeps: { "@earendil-works/pi-ai": "^1.5.2" } });
  expect(() => { checkPiManifestConsistency(splitCli.oar, splitCli.cli, splitCli.pi); }).toThrow(/Pi family range mismatch/u);
  const caretAll = sampleManifests({
    oarOptional: { "@earendil-works/pi-ai": "^1.5.2", "@earendil-works/pi-coding-agent": "^1.5.2" },
    oarPeers: { "@earendil-works/pi-durable": "^1.5.2", "@earendil-works/chord": "^1.5.2" },
    cliDeps: { "@earendil-works/pi-ai": "^1.5.2", "@earendil-works/pi-coding-agent": "^1.5.2" },
  });
  expect(() => { checkPiManifestConsistency(caretAll.oar, caretAll.cli, caretAll.pi); }).toThrow(/must be ~X\.Y\.Z or exact X\.Y\.Z/u);
  const splitUndici = sampleManifests({ oarUndici: "8.12.3", piUndici: "8.12.4" });
  expect(() => { checkPiManifestConsistency(splitUndici.oar, splitUndici.cli, splitUndici.pi); }).toThrow(/dependencies\.undici/u);
});
