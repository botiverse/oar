/** Linux-only, account-free initialize probe. Requires bubblewrap; sends no prompt. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";

const [binary] = process.argv.slice(2);
assert.ok(process.platform === "linux" && binary !== undefined && path.isAbsolute(binary));
const home = await mkdtemp(path.join(os.tmpdir(), "oar-agy-acp-handshake-"));
const child = spawn("bwrap", [
  "--unshare-net", "--die-with-parent", "--new-session",
  "--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib",
  "--ro-bind", "/lib64", "/lib64", "--ro-bind", "/etc", "/etc",
  "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
  "--ro-bind", binary, "/agy", "--bind", home, "/home/probe",
  "--chdir", "/home/probe", "/agy", "acp", "--disable-telemetry",
], {
  env: { PATH: "/usr/bin:/bin", HOME: "/home/probe", XDG_CONFIG_HOME: "/home/probe/.config", XDG_DATA_HOME: "/home/probe/.data", XDG_CACHE_HOME: "/home/probe/.cache" },
  stdio: ["pipe", "pipe", "pipe"],
});
const frames: Record<string, unknown>[] = [];
let stderr = "";
const observed: { launchError: string | null; parseError: string | null; exited: boolean } = { launchError: null, parseError: null, exited: false };
const isExited = (): boolean => observed.exited;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
child.on("error", (error) => { observed.launchError = error.message; });
// oxlint-disable-next-line promise/avoid-new -- Observe child closure even after a spawn error.
const closed = new Promise<void>((resolve) => { child.once("close", () => { observed.exited = true; resolve(); }); });
child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(-4000); });
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  try {
    const frame: unknown = JSON.parse(line);
    assert.ok(isRecord(frame));
    frames.push(frame);
  }
  catch (error) { observed.parseError = String(error); }
});
child.stdin.on("error", () => {});
try {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "oar-interface-probe", version: "1" } } })}\n`);
  const deadline = Date.now() + 20_000;
  while (!isExited() && !frames.some((frame) => frame.id === 1) && Date.now() < deadline) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Bound this single native handshake, not concurrent requests.
    await sleep(20);
  }
  const response = frames.find((frame) => frame.id === 1);
  console.log(JSON.stringify({ network: "isolated namespace", authenticated: false, promptSent: false, initialize: response ?? null, launchError: observed.launchError, stderr: stderr.replaceAll(home, "<probe-home>") }, null, 2));
  assert.ok(response !== undefined, "initialize did not return within 20 seconds");
  assert.equal(observed.parseError, null, "stdout contained a non-JSON frame");
  assert.ok(response.result !== undefined, "native initialize returned an error");
} finally {
  child.kill("SIGKILL");
  await closed;
  lines.close();
  await rm(home, { recursive: true, force: true });
}
