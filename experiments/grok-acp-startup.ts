/* oxlint-disable import/max-dependencies -- Standalone launch experiment composes existing fixture, redaction and process cleanup helpers. */
/**
 * Compare the npm wrapper, its Node launcher and the native binary using the
 * same isolated Grok configuration and initialize request. No model is called.
 * Run: pnpm tsx experiments/grok-acp-startup.ts "$(npm root -g)"
 * Outcomes are measurements, not a replacement for the required behavior tests.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { grokInstallation } from "../packages/oar/src/runtimes/grok/installation.js";
import { sessionEnvironment } from "../packages/oar/src/shared/environment.js";
import { sessionCredentialRedactor } from "../packages/oar/src/shared/credential-redactor.js";
import { killProcessTree, OWN_PROCESS_GROUP, signalProcessGroup } from "../packages/oar/src/shared/executable/process.js";
import { windowsSpawnTarget } from "../packages/oar/src/shared/executable/windows-shim.js";
import { asRecord, parseJson } from "../packages/oar/src/shared/json.js";
import { startGrokAimock } from "../sea-trial/harness/aimock-acp.js";

const [npmRoot] = process.argv.slice(2);
assert.ok(npmRoot !== undefined && npmRoot.length > 0, "Pass the installed npm package root");
const launcher = path.join(npmRoot, "@xai-official", "grok", "bin", "grok-bootstrap.js");
const native = process.env.GROK_PROBE_NATIVE ?? path.join(
  process.env.GROK_HOME ?? path.join(homedir(), ".grok"), "bin", process.platform === "win32" ? "grok.exe" : "grok",
);
assert.ok(existsSync(launcher), "The installed Grok Node launcher must exist");
assert.ok(existsSync(native), "The installed Grok native binary must exist");
const installation = await grokInstallation();
assert.equal(installation.kind, "available");
assert.equal(installation.via, "executable");
const args = ["agent", "--always-approve", "--no-leader", "stdio"];
const root = process.env.OAR_TRIAL_RUN_DIR ?? "oar-trial-run";
await mkdir(root, { recursive: true });
const file = path.join(root, "grok-acp-startup.jsonl");

interface Variant {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly pipes: "pipe" | "overlapped";
}

const variants: readonly Variant[] = [
  { name: "oar-installation", command: installation.command, args, pipes: "pipe" },
  { name: "npm-wrapper", command: "grok", args, pipes: "pipe" },
  { name: "node-launcher", command: process.execPath, args: [launcher, ...args], pipes: "pipe" },
  { name: "native", command: native, args, pipes: "pipe" },
  { name: "native-overlapped", command: native, args, pipes: "overlapped" },
];

async function probe(variant: Variant): Promise<unknown> {
  const fixture = await startGrokAimock((mock) => { mock.onMessage(/[\s\S]*/u, { content: "unused" }); });
  const env = sessionEnvironment(fixture.env);
  const { redact } = sessionCredentialRedactor({ env: Object.fromEntries(Object.entries(env).map(([key, value]) => [key, value ?? null])) });
  const target = windowsSpawnTarget(variant.command, variant.args, { env });
  const started = Date.now();
  const child = spawn(target.command, [...target.args], {
    env, detached: OWN_PROCESS_GROUP, windowsHide: true,
    windowsVerbatimArguments: target.windowsVerbatimArguments ?? false,
    stdio: [variant.pipes, variant.pipes, variant.pipes],
  });
  const closed = Promise.withResolvers<boolean>();
  child.once("close", () => { closed.resolve(true); });
  const answer = Promise.withResolvers<string>();
  child.once("error", () => { answer.resolve("spawn_error"); });
  child.once("exit", () => { answer.resolve("exited"); });
  child.stdin.on("error", () => { answer.resolve("stdin_error"); });
  let stderr = "";
  let stdoutBytes = 0;
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
  child.stdout.on("data", (chunk: Buffer) => { stdoutBytes += chunk.length; });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = asRecord(parseJson(line));
    if (message?.id === 1) {
      answer.resolve(typeof asRecord(message.result)?.protocolVersion === "number" ? "initialized" : "native_error");
    }
  });
  const timer = setTimeout(() => { answer.resolve("timed_out"); }, 15_000);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: {
      protocolVersion: 1, clientInfo: { name: "oar", version: "0.0.0" },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: true },
    },
  })}\n`);
  try {
    const outcome = await answer.promise;
    return { name: variant.name, outcome, elapsedMs: Date.now() - started, stdoutBytes, stderr: redact(stderr) };
  } finally {
    clearTimeout(timer);
    lines.close();
    if (process.platform === "win32") { killProcessTree(child); }
    else { signalProcessGroup(child, "SIGKILL"); }
    const cleanupTimer = setTimeout(() => { closed.resolve(false); }, 5000);
    const didClose = await closed.promise;
    clearTimeout(cleanupTimer);
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    await fixture.stop();
    assert.ok(didClose, "The startup probe child must exit after cleanup");
  }
}

for (const variant of variants) {
  // Preserve which launch began even if its cleanup fails.
  // oxlint-disable-next-line eslint/no-await-in-loop -- Sequential cold launches isolate the entry-point difference.
  await appendFile(file, `${JSON.stringify({ phase: "start", name: variant.name, platform: process.platform, version: installation.version })}\n`);
  // oxlint-disable-next-line eslint/no-await-in-loop -- Each variant owns and cleans up its own isolated configuration.
  const result = await probe(variant);
  const line = `${JSON.stringify(result)}\n`;
  process.stdout.write(line);
  // oxlint-disable-next-line eslint/no-await-in-loop -- Persist every result before starting the next variant.
  await appendFile(file, line);
}
