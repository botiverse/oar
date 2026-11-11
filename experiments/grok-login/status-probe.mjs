/* oxlint-disable -- Standalone read-only probe, run by hand against a real Grok install. */
// Read-only: how a Grok install reports its sign-in, without signing in or out.
//   node experiments/grok-login/status-probe.mjs <grok-binary>
// Prints whether `grok models` says "You are not authenticated." and what
// ACP `_x.ai/auth/info` (with no `authenticate` first) reports: its methodId
// and whether an email is present. Never prints the email or any token.
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

const [bin] = process.argv.slice(2);
if (bin === undefined) { throw new Error("usage: status-probe.mjs <grok-binary>"); }
const models = spawnSync(bin, ["models"], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
const text = `${models.stdout}\n${models.stderr}`;
console.log(JSON.stringify({ grokModels: { exit: models.status, saysNotAuthenticated: text.includes("You are not authenticated."), firstLineShape: (text.trim().split("\n")[0] ?? "").replace(/\S+@\S+/gu, "<email>").slice(0, 80) } }));

const child = spawn(bin, ["agent", "--always-approve", "--no-leader", "stdio"], { stdio: ["pipe", "pipe", "ignore"] });
const waiting = new Map(); let next = 1;
createInterface({ input: child.stdout }).on("line", (line) => { let m; try { m = JSON.parse(line); } catch { return; } if (m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
const request = (method, params) => new Promise((resolve) => { const id = next++; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); setTimeout(() => { resolve({ timeout: true }); }, 15_000); });
const init = await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
const info = await request("_x.ai/auth/info", {});
const result = info.result ?? {};
console.log(JSON.stringify({ authMethods: (init.result?.authMethods ?? []).map((m) => m.id), authInfo: info.timeout ? "timeout" : info.error ? { error: info.error.code } : { methodId: result.methodId ?? null, hasEmail: typeof result.email === "string" && result.email.length > 0, principalType: result.principalType ?? null } }));
child.kill();
