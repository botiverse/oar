import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { expect, test } from "vitest";
import {
  installedSessionCapabilities,
  type AvailableInstallation,
  type ContextUsageCapability,
  type McpTransport,
  type SessionCapabilityDeclaration,
} from "../packages/oar/src/capabilities.js";

test("the capabilities entry bundles with no externals, no Node imports, and no runtime or SDK modules", async () => {
  const result = await build({
    entryPoints: ["packages/oar/src/capabilities.ts"], bundle: true, platform: "browser", format: "esm", write: false, metafile: true,
    plugins: [{ name: "no-node", setup(builder) {
      // oxlint-disable-next-line require-unicode-regexp
      builder.onResolve({ filter: /^node:/ }, (args) => ({ errors: [{ text: `Node import ${args.path} from ${args.importer}` }] }));
    } }],
  });
  expect(Object.values(result.metafile.outputs).flatMap((output) => output.imports)).toEqual([]);
  const outside = Object.keys(result.metafile.inputs).filter((file) => file !== "packages/oar/src/capabilities.ts" && !file.startsWith("packages/oar/src/contracts/"));
  expect(outside).toEqual([]);
});

const SIDE_EFFECT_PROBE = String.raw`
import assert from "node:assert/strict";
const before = new Set(Object.getOwnPropertyNames(globalThis));
const resources = process.getActiveResourcesInfo().length;
const mod = await import(process.argv[1]);
assert.deepEqual(Object.keys(mod), ["installedSessionCapabilities"]);
const merged = mod.installedSessionCapabilities(
  { refusedSessionOptions: { fork: "static" }, sessionCapabilities: () => ({ steer: true }) },
  { kind: "available", via: "executable", command: "/bin/agent", version: "1.0.0" },
);
assert.deepEqual(merged, { steer: true, refusedSessionOptions: { fork: "static" } });
const added = Object.getOwnPropertyNames(globalThis).filter((name) => !before.has(name));
if (added.length > 0) { console.error("global written: " + added.join(",")); process.exit(3); }
if (process.getActiveResourcesInfo().length > resources) { console.error("left running: " + process.getActiveResourcesInfo().join(",")); process.exit(4); }
`;

async function probeBundle(banner: string): Promise<number> {
  const dir = mkdtempSync(path.join(tmpdir(), "oar-capabilities-probe-"));
  try {
    const result = await build({
      entryPoints: ["packages/oar/src/capabilities.ts"], bundle: true, platform: "neutral", format: "esm", write: false,
      banner: { js: banner },
    });
    const file = path.join(dir, "capabilities.mjs");
    writeFileSync(file, result.outputFiles[0]?.text ?? "");
    execFileSync(process.execPath, ["--input-type=module", "-e", SIDE_EFFECT_PROBE, pathToFileURL(file).href], { stdio: "pipe" });
    return 0;
  } catch (error) {
    const status: unknown = typeof error === "object" && error !== null ? Reflect.get(error, "status") : undefined;
    return typeof status === "number" ? status : -1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("importing and calling the capabilities entry writes no global and leaves nothing running", async () => {
  expect(await probeBundle("")).toBe(0);
  expect(await probeBundle("globalThis.__capabilitiesSideEffect = 1;")).toBe(3);
  expect(await probeBundle("setInterval(() => {}, 60_000);")).toBe(4);
});

test("installedSessionCapabilities from the capabilities entry merges static and per-installation declarations", () => {
  const installation: AvailableInstallation = { kind: "available", via: "executable", command: "/bin/agent", version: "2.0.0" };
  const contextUsage: ContextUsageCapability = { tokens: true, contextWindow: true };
  const mcpTransports: readonly McpTransport[] = ["stdio", "http"];
  const declared: SessionCapabilityDeclaration = installedSessionCapabilities({
    refusedSessionOptions: { name: "static" },
    manualCompaction: { kind: "unsupported", reason: "static" },
    sessionCapabilities: () => ({ steer: true, stopTask: true, contextUsage, mcpTransports, refusedSessionOptions: { fork: "version" } }),
  }, installation);
  expect(declared).toEqual({
    steer: true,
    stopTask: true,
    contextUsage,
    mcpTransports,
    refusedSessionOptions: { name: "static", fork: "version" },
    manualCompaction: { kind: "unsupported", reason: "static" },
  });
});
