/** Pi 1.4.0's exported RPC entry, independent of OAR's session adapter. Local provider only. */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { LLMock } from "@copilotkit/aimock";
import { asRecord, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { startRawCapture } from "../../sea-trial/harness/raw-capture.js";

const destination = path.resolve(process.argv[2] ?? "oar-trial-run/pi-rpc-native");
await mkdir(destination, { recursive: true });
const root = await mkdtemp(path.join(tmpdir(), "oar-pi-rpc-native-"));
const cwd = path.join(root, "project");
const agentDir = path.join(root, "agent");
await mkdir(cwd); await mkdir(agentDir);
const mock = new LLMock({ port: 0 });
mock.onMessage(/[\s\S]*/u, { content: "native answer" });
await mock.start();
const capture = await startRawCapture(mock.url);
await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { aimock: {
  name: "aimock", baseUrl: capture.url, apiKey: "aimock", api: "anthropic-messages",
  models: [{ id: "thinking", name: "thinking", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 16_384 }],
} } }));
await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultThinkingLevel: "low" }));
const frames: JsonRecord[] = [];
const facts: unknown[] = [];
async function run(resume?: string): Promise<string> {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry")),
    "--approve", ...(resume === undefined ? ["--model", "aimock/thinking", "--thinking", "high"] : ["--session", resume])], {
    cwd, env: { ...process.env, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: agentDir, NO_PROXY: "*" }, stdio: ["pipe", "pipe", "pipe"],
  });
  const { promise: exit, resolve: exited } = Promise.withResolvers<number | null>();
  const state = { ended: false, settled: false };
  let stderr = "";
  let sequence = 0;
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192); });
  const pending = new Map<string, ReturnType<typeof Promise.withResolvers<JsonRecord>>>();
  child.once("exit", (code) => {
    state.ended = true; exited(code);
    for (const waiter of pending.values()) { waiter.reject(new Error(`Native exit ${String(code)}: ${stderr}`)); }
  });
  child.once("error", (error) => {
    state.ended = true; exited(null);
    for (const waiter of pending.values()) { waiter.reject(error); }
  });
  const reader = createInterface({ input: child.stdout });
  reader.on("line", (line) => {
    const value = asRecord(parseJson(line));
    if (value === null) { stderr += `\nUnexpected stdout: ${line}`; return; }
    frames.push(value);
    if (value.type === "agent_settled") { state.settled = true; }
    if (typeof value.id === "string") { pending.get(value.id)?.resolve(value); }
  });
  const request = async (type: string, args: JsonRecord = {}): Promise<JsonRecord> => {
    const id = `probe-${sequence++}`;
    const waiter = Promise.withResolvers<JsonRecord>();
    pending.set(id, waiter);
    child.stdin.write(`${JSON.stringify({ type, id, ...args })}\n`);
    try { return await waiter.promise; }
    finally { pending.delete(id); }
  };
  const timer = setTimeout(() => { if (!state.ended) { child.kill("SIGKILL"); } }, 45_000);
  try {
    facts.push(await request("get_state"), await request("prompt", { message: resume === undefined ? "original history marker" : "after resume" }));
    // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- The native stdout callback changes this state.
    while (!state.settled) {
      if (state.ended) { throw new Error(`Native process exited before agent_settled: ${stderr}`); }
      // oxlint-disable-next-line eslint/no-await-in-loop -- Wait for the native event, bounded by the process deadline above.
      await delay(20);
    }
    facts.push(await request("get_session_stats"));
    const after = await request("get_state");
    facts.push(after);
    child.stdin.end();
    facts.push({ exit: await exit, stderr });
    const data = asRecord(after.data);
    if (typeof data?.sessionFile !== "string") { throw new TypeError("No persisted native session file"); }
    return data.sessionFile;
  } finally {
    if (!state.ended) { child.kill("SIGKILL"); }
    await exit;
    clearTimeout(timer); reader.close();
  }
}
try {
  const sessionFile = await run();
  await run(sessionFile);
  facts.push({ settings: await readFile(path.join(agentDir, "settings.json"), "utf8") });
  const safeJson = (value: unknown): string => JSON.stringify(value, null, 2).replaceAll(root, "<temporary-home>");
  await writeFile(path.join(destination, "frames.json"), safeJson(frames));
  await writeFile(path.join(destination, "facts.json"), safeJson(facts));
  await writeFile(path.join(destination, "provider.json"), safeJson(capture.requests));
  process.stdout.write(`Native RPC evidence: ${destination}\n`);
} finally { await capture.stop(); await mock.stop(); await rm(root, { recursive: true, force: true }); }
