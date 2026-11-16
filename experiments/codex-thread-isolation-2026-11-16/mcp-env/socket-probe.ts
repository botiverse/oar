/** Separate loopback WebSocket observation; OAR's production transport remains stdio. */
/* oxlint-disable no-await-in-loop -- Native calls and the model-invoked reader are deliberately ordered. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { childSource } from "./child-source.js";
import { socketChildSource } from "./socket-child-source.js";
import { codexFixture } from "../../sharing/codex-fixture.js";
import { spawnLineProcess, type LineProcess } from "../../../packages/oar/src/shared/executable/index.js";
import { asRecord, type JsonRecord } from "../../../packages/oar/src/shared/json.js";

const out = path.resolve(process.argv[2] ?? "oar-trial-run/codex-mcp-socket");
await mkdir(out, { recursive: true });
const fixture = await codexFixture();
const frames: JsonRecord[] = [];
const calls: JsonRecord[] = [];
const tokens = { mcpA: "OAR_SYNTHETIC_243_WS_MCP_A", mcpB: "OAR_SYNTHETIC_243_WS_MCP_B", shellA: "OAR_SYNTHETIC_243_WS_SHELL_A", shellB: "OAR_SYNTHETIC_243_WS_SHELL_B" };
let server: LineProcess | null = null;
let socket: WebSocket | null = null;
let failure: string | null = null;
let childReads: unknown = null;
try {
  assert.equal(fixture.installation.version, "codex-cli 0.169.0");
  const env = { HOME: fixture.home, USERPROFILE: fixture.home, PATH: process.env.PATH ?? "", NO_PROXY: "*", ...fixture.provider.env };
  server = spawnLineProcess(process.env.OAR_CODEX_BIN ?? "codex", ["app-server", "-c", 'sandbox_mode="danger-full-access"', "-c", "features.code_mode=false", "--listen", "ws://127.0.0.1:0"], { cwd: fixture.home, env, killTree: true });
  await server.spawned;
  const processHandle = server;
  const endpoint = (): string | undefined => /ws:\/\/127\.0\.0\.1:\d+/u.exec(processHandle.diagnostics().stderr)?.[0];
  await fixture.timing.until(() => endpoint() !== undefined, "native WebSocket listener");
  const url = endpoint(); assert.ok(url !== undefined);
  const ws = new WebSocket(url); socket = ws;
  const opened = Promise.withResolvers<void>();
  ws.addEventListener("open", () => { opened.resolve(); });
  ws.addEventListener("error", () => { opened.reject(new Error("WebSocket failed")); });
  const pending = new Map<number, ReturnType<typeof Promise.withResolvers<JsonRecord>>>();
  ws.addEventListener("message", (event) => {
    const value: unknown = JSON.parse(String(event.data)); const frame = asRecord(value); if (frame === null) { return; } frames.push(frame);
    if (typeof frame.id === "number") {
      const waiter = pending.get(frame.id); pending.delete(frame.id);
      if (frame.error === undefined) { waiter?.resolve(asRecord(frame.result) ?? {}); }
      else { waiter?.reject(new Error(JSON.stringify(frame.error))); }
    }
  });
  await fixture.timing.wait(opened.promise, "connect native WebSocket");
  let serial = 0;
  const request = async (method: string, params: JsonRecord): Promise<JsonRecord> => {
    const id = ++serial; const waiter = Promise.withResolvers<JsonRecord>(); pending.set(id, waiter);
    ws.send(JSON.stringify({ id, method, params }));
    const result = await fixture.timing.wait(waiter.promise, method); calls.push({ method, params, result }); return result;
  };
  await request("initialize", { clientInfo: { name: "oar-synthetic-socket", version: "1" }, capabilities: { experimentalApi: true } });
  ws.send(JSON.stringify({ method: "initialized", params: {} }));
  const child = path.join(fixture.home, "child.cjs");
  await writeFile(child, childSource);
  await writeFile(path.join(fixture.home, "tool.mjs"), socketChildSource);
  const ids: string[] = [];
  for (const label of ["A", "B"] as const) {
    const result = await request("thread/start", { cwd: fixture.cwds[0], approvalPolicy: "never", model: "gpt-5.1", config: {
      shell_environment_policy: { set: { OAR_SHELL_TOKEN: label === "A" ? tokens.shellA : tokens.shellB } },
      mcp_servers: { scope: { command: process.execPath, args: [child, "mcp"], env: { OAR_MCP_TOKEN: label === "A" ? tokens.mcpA : tokens.mcpB } } },
    } });
    const id = asRecord(result.thread)?.id; assert.equal(typeof id, "string"); ids.push(String(id));
  }
  await writeFile(path.join(fixture.home, "socket-manifest.json"), JSON.stringify({ url, peer: ids[1], cwd: fixture.cwds[0] }));
  const peerResult = await request("turn/start", { threadId: ids[1], input: [{ type: "text", text: "OAR_SHARE_B_echo" }] });
  const peerTurn = asRecord(peerResult.turn)?.id;
  await fixture.timing.until(() => frames.some(frame => frame.method === "turn/completed" && asRecord(asRecord(frame.params)?.turn)?.id === peerTurn), "peer history persisted");
  const result = await request("turn/start", { threadId: ids[0], input: [{ type: "text", text: "OAR_SHARE_A_cwd" }] });
  const turnId = asRecord(result.turn)?.id;
  await fixture.timing.until(() => frames.some(frame => frame.method === "turn/completed" && asRecord(asRecord(frame.params)?.turn)?.id === turnId), "socket reader turn completion");
  childReads = JSON.parse(await readFile(path.join(fixture.home, "socket-reads.json"), "utf8"));
} catch (error) { failure = String(error); }
finally {
  await writeFile(path.join(out, "evidence.json"), JSON.stringify({ transport: "explicit loopback WebSocket, no transport authentication", installation: fixture.installation, tokens, failure, childReads, calls, frames,
    providerScans: fixture.provider.raw.map((request, index) => ({ index, hits: Object.entries(tokens).filter(([, token]) => JSON.stringify(request).includes(token)).map(([key]) => key) })), rawRequests: fixture.provider.raw }, null, 2));
  socket?.close(); server?.kill(); await server?.exited; await fixture.stop();
}
console.log(JSON.stringify({ failure, captured: childReads !== null }));
assert.equal(failure, null, "socket evidence retained on failure");
