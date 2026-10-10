import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { expect, test } from "vitest";

const FLOWS = ["anthropic", "openai-codex", "openai-chatgpt", "github-copilot", "openrouter", "kimi-coding", "meta", "xai"];

function lines(state: string): string {
  return `${FLOWS.map((name) => `${name} ${state}`).join("\n")}\n`;
}

// #328: a host bundled into one file (a Node single executable) has no pi-ai
// files beside it. pi-ai loads its sign-in flows by a computed path, so each
// failed until OAR handed pi-ai its static table.
test("a single-file host loads pi's sign-in flows once OAR hands pi-ai its modules", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oar-pi-bundle-"));
  const host = join(dir, "host.mjs");
  // ESM like the source; esbuild's ESM output cannot require Node built-ins, so give it a require.
  const banner = { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" };
  const result = await build({ entryPoints: ["tests/fixtures/pi-bundled-host.ts"], bundle: true, platform: "node", format: "esm", banner, outfile: host, logLevel: "silent", metafile: true });
  // Bedrock's implementation is in the bundle too, not left to a computed path.
  expect(Object.keys(result.metafile.inputs).some((file) => file.endsWith("pi-ai/dist/api/bedrock-converse-stream.js"))).toBe(true);
  const run = (args: readonly string[]): string => spawnSync(process.execPath, [host, ...args], { cwd: dir, encoding: "utf8" }).stdout;
  expect(run([])).toBe(lines("missing"));
  expect(run(["provide"])).toBe(lines("ok"));
}, 60_000);
