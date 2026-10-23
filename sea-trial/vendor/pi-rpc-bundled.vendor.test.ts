import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { expect, test } from "vitest";
import { startPiAimock } from "../harness/aimock.js";
import { runExecutable } from "../../packages/oar/src/shared/executable/index.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";

test.skipIf(process.env.OAR_TEST !== "pi-rpc-aimock")("a single-file OAR host starts a selected native Pi without adjacent OAR source or dependencies", async () => {
  const env = await startPiAimock((mock) => { mock.onMessage(/[\s\S]*/u, { content: "bundle works" }); }, { reasoningModel: true, contextWindow: 200_000 });
  const dir = await mkdtemp(path.join(tmpdir(), "oar-pi-rpc-bundle-"));
  try {
    const host = path.join(dir, "host.mjs");
    await build({ entryPoints: ["tests/fixtures/pi-rpc-bundled-host.ts"], bundle: true, platform: "node", format: "esm",
      banner: { js: "import { createRequire as __oarRequire } from 'node:module'; const require = __oarRequire(import.meta.url);" }, outfile: host, logLevel: "silent" });
    const missing = await runExecutable(process.execPath, [host], { cwd: dir, env: { ...process.env, ...env.env }, timeoutMs: 30_000 });
    expect(missing.ok).toBe(false);
    expect(missing.stderr).toContain("A single-file host must provide command for Pi subprocess execution");
    const command = path.resolve(`node_modules/.bin/pi${process.platform === "win32" ? ".cmd" : ""}`);
    const result = await runExecutable(process.execPath, [host, command], { cwd: dir, env: { ...process.env, ...env.env }, timeoutMs: 60_000 });
    expect(result.ok, result.stderr).toBe(true);
    const last = result.stdout.trim().split("\n").at(-1) ?? "";
    expect(asRecord(parseJson(last))).toMatchObject({ result: { kind: "ended", outcome: { kind: "completed" } }, context: { contextWindow: 200_000 } });
  } finally { await env.stop(); await rm(dir, { recursive: true, force: true }); }
}, 90_000);
