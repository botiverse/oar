import assert from "node:assert/strict";
import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { expect, test } from "vitest";

async function exec(command: string, args: string[], options: Omit<ExecFileOptionsWithStringEncoding, "encoding">): Promise<{ stdout: string }> {
  const result = Promise.withResolvers<{ stdout: string }>();
  // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Bridge Node's callback-only execFile without blocking the loopback HTTP server.
  execFile(command, args, { ...options, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
    if (error) { result.reject(new Error(`${error.message}\n${stderr}`)); }
    else { result.resolve({ stdout }); }
  });
  return result.promise;
}
const isolatedEnv = (directory: string): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: directory, TMP: directory,
  HOME: directory, USERPROFILE: directory, OAR_PI_AGENT_DIR: directory, PI_CODING_AGENT_DIR: directory,
});

test("opening native Pi and querying auth leaves Bedrock and AWS unloaded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oar-pi-lazy-"));
  try {
    const result = await exec(process.execPath, ["--import", "tsx", "tests/fixtures/pi-lazy-bedrock.ts", directory],
      { env: isolatedEnv(directory), timeout: 30_000 });
    expect(result.stdout).toBe('{"afterOpen":0,"afterAuth":0}\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 40_000);

// oxlint-disable-next-line max-statements -- One local HTTP server and bundled child exercise the first native request end to end.
test("a single-file host's first lazy Bedrock request reaches its local provider", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oar-pi-lazy-bundle-"));
  const requests: { method: string | undefined; path: string | undefined; body: string }[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      requests.push({ method: request.method, path: request.url, body });
      response.writeHead(400, { "content-type": "application/json", "x-amzn-errortype": "ValidationException" });
      response.end(JSON.stringify({ message: "local-bedrock-probe" }));
    });
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  try {
    const host = join(directory, "host.mjs");
    const address = server.address();
    assert.ok(address !== null && typeof address === "object");
    await build({ entryPoints: ["tests/fixtures/pi-bundled-bedrock.ts"], bundle: true, platform: "node", format: "esm", outfile: host, logLevel: "silent",
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
    const result = await exec(process.execPath, [host, `http://127.0.0.1:${address.port}`],
      { cwd: directory, env: isolatedEnv(directory), timeout: 20_000 });
    expect(result.stdout).toBe("bedrock reached local provider\n");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.path).toBe("/model/probe-model/converse-stream");
    const body: unknown = JSON.parse(requests[0]?.body ?? "null");
    expect(body).toMatchObject({ messages: [{ role: "user", content: [{ text: "local probe" }] }] });
  } finally {
    server.closeAllConnections();
    await server[Symbol.asyncDispose]();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
