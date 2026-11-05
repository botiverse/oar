/* oxlint-disable eslint/max-statements, eslint/max-lines-per-function -- Keep the independent native probe and cleanup together. */
/**
 * Compare fresh-process Kimi ACP resume configurations against a local provider.
 * No OAR runtime, login, account, or external provider is used.
 * node --import tsx experiments/kimi-mcp-resume/native.ts <binary> <output-dir>
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { startKimiAimock } from "../../sea-trial/harness/aimock-acp.js";
import { ECHO_SERVER, echoFixtures, startHttpEcho } from "../../sea-trial/vendor/support/echo-mcp.js";

const [command, output] = process.argv.slice(2);
assert.ok(command !== undefined && output !== undefined, "usage: <binary> <output-dir>");
assert.equal(process.platform, "linux", "this diagnostic uses POSIX process groups");
const binary = path.resolve(command);
const out = path.resolve(output);
await mkdir(out, { recursive: true });
const http = await startHttpEcho();
const canaries = ["SYNTHETIC_STDIO_OLD_164", "SYNTHETIC_HTTP_OLD_164", "SYNTHETIC_STDIO_NEW_164", "SYNTHETIC_HTTP_NEW_164"];
type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const object = (value: unknown): Json => isObject(value) ? value : {};
const list = (value: unknown): readonly unknown[] => Array.isArray(value) ? value : [];
const servers = (replacement = false, renamed = false): readonly Json[] => [
  { name: renamed ? "newstdio" : "echo", command: process.execPath, args: [ECHO_SERVER], env: [{ name: "OAR_ECHO_TOKEN", value: canaries[replacement ? 2 : 0] }] },
  { name: renamed ? "newhttp" : "remote", type: "http", url: http.url, headers: [{ name: "Authorization", value: canaries[replacement ? 3 : 1] }] },
];
const variants: readonly { name: string; servers?: readonly Json[]; calls: readonly string[] }[] = [
  { name: "omitted", calls: ["echo", "remote"] },
  { name: "empty", servers: [], calls: ["echo", "remote"] },
  { name: "same-names", servers: servers(true), calls: ["echo", "remote"] },
  { name: "new-names", servers: servers(true, true), calls: ["echo", "remote", "newstdio", "newhttp"] },
];
const fixture = await startKimiAimock((mock) => {
  for (const variant of variants) {
    for (const phase of ["seed", "resume"] as const) {
      const marker = `${variant.name}-${phase}`;
      echoFixtures(mock, new RegExp(`probe-${marker}`, "u"), (phase === "seed" ? ["echo", "remote"] : variant.calls).map((server) => ({ server, text: `${marker}-${server}` })));
    }
  }
});
const cwd = path.join(fixture.env.HOME ?? "", "project");
await mkdir(cwd, { recursive: true });
const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: "C.UTF-8", ...fixture.env };
const version = execFileSync(binary, ["--version"], { env, encoding: "utf8" }).trim();

async function turn(label: string, sessionId: string | undefined, mcpServers: readonly Json[] | undefined): Promise<{ sessionId: string; facts: Json }> {
  const frames: Json[] = [];
  const stderr: string[] = [];
  const before = fixture.raw.length;
  const child = spawn(binary, ["acp"], { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  const closed = Promise.withResolvers<void>();
  const pending = new Map<number, ReturnType<typeof Promise.withResolvers<unknown>>>();
  child.on("close", () => {
    for (const waiter of pending.values()) { waiter.reject(new Error("native process exited")); }
    closed.resolve();
  });
  child.on("error", (error) => { for (const waiter of pending.values()) { waiter.reject(error); } });
  child.stderr.on("data", (chunk: Buffer) => { stderr.push(chunk.toString()); });
  const send = (message: Json): void => { frames.push({ direction: "out", ...message }); child.stdin.write(`${JSON.stringify(message)}\n`); };
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = object(JSON.parse(line));
    frames.push({ direction: "in", ...message });
    if (typeof message.method === "string" && message.id !== undefined) {
      const option = list(object(message.params).options).map((item) => object(item)).find((item) => item.kind === "allow_once");
      send(message.method === "session/request_permission" && option !== undefined
        ? { jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "selected", optionId: option.optionId } } }
        : { jsonrpc: "2.0", id: message.id, error: { code: -32_601, message: "Client method unsupported" } });
    } else if (typeof message.id === "number") {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error === undefined) { waiter?.resolve(message.result); }
      else { waiter?.reject(new Error(JSON.stringify(message.error))); }
    }
  });
  let nextId = 0;
  const request = async (method: string, params: Json): Promise<unknown> => {
    const id = nextId++;
    const response = Promise.withResolvers<unknown>();
    pending.set(id, response);
    const timer = setTimeout(() => { response.reject(new Error(`timeout: ${method}`)); }, 60_000);
    try { send({ jsonrpc: "2.0", id, method, params }); return await response.promise; }
    finally { clearTimeout(timer); pending.delete(id); }
  };
  try {
    const initialized = await request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "native-mcp-resume-probe", version: "1" } });
    const opened = object(await request(sessionId === undefined ? "session/new" : "session/resume", {
      cwd, ...(sessionId === undefined ? {} : { sessionId }), ...(mcpServers === undefined ? {} : { mcpServers }),
    }));
    const id = sessionId ?? String(opened.sessionId);
    assert.ok(id !== "undefined");
    await request("session/set_mode", { sessionId: id, modeId: "yolo" });
    const result = await request("session/prompt", { sessionId: id, prompt: [{ type: "text", text: `probe-${label}` }] });
    const requests = fixture.raw.slice(before);
    assert.ok(requests.length > 0, "the native session must reach the isolated provider");
    const first = object(requests[0]?.body);
    const tools = list(first.tools).map((tool) => String(object(object(tool).function).name)).filter((name) => name.startsWith("mcp__"));
    const toolResults = requests.flatMap((entry) => list(object(entry.body).messages).map((item) => object(item))).filter((message) => message.role === "tool" && String(message.tool_call_id).startsWith(`call_${label}-`));
    const uniqueResults = [...new Map(toolResults.map((message) => [String(message.tool_call_id), message])).values()];
    const updates = frames.filter((frame) => frame.direction === "in" && frame.method === "session/update").map((frame) => object(object(frame.params).update));
    return { sessionId: id, facts: { label, initialized, supplied: mcpServers === undefined ? "omitted" : mcpServers.map((server) => server.name), tools, toolResults: uniqueResults, result, updates } };
  } finally {
    if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
      process.kill(-child.pid, "SIGTERM");
      const kill = setTimeout(() => { if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) { process.kill(-child.pid, "SIGKILL"); } }, 3000);
      await closed.promise;
      clearTimeout(kill);
    }
    lines.close();
    await writeFile(path.join(out, `${label}.wire.json`), JSON.stringify(frames, null, 2));
    await writeFile(path.join(out, `${label}.stderr.txt`), stderr.join(""));
    await writeFile(path.join(out, `${label}.provider.json`), JSON.stringify(fixture.raw.slice(before), null, 2));
  }
}

const facts: Json[] = [];
try {
  for (const variant of variants) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each resume must follow a completed seed and a closed native process.
    const seeded = await turn(`${variant.name}-seed`, undefined, servers());
    facts.push(seeded.facts);
    // oxlint-disable-next-line eslint/no-await-in-loop -- The resumed session belongs to this seed.
    const resumed = await turn(`${variant.name}-resume`, seeded.sessionId, variant.servers);
    facts.push(resumed.facts);
    console.log(JSON.stringify({ variant: variant.name, tools: resumed.facts.tools, toolResults: resumed.facts.toolResults }));
  }
} finally {
  const kimiHome = fixture.env.KIMI_CODE_HOME;
  assert.ok(kimiHome !== undefined);
  await cp(kimiHome, path.join(out, "native-home"), { recursive: true });
  const storedCanaries: { file: string; markers: readonly number[] }[] = [];
  const storedFiles = await readdir(kimiHome, { recursive: true, withFileTypes: true });
  for (const file of storedFiles.filter((entry) => entry.isFile())) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Retain a bounded scan of only this synthetic isolated home.
    const bytes = await readFile(path.join(file.parentPath, file.name));
    const markers = canaries.flatMap((canary, index) => bytes.includes(canary) ? [index] : []);
    if (markers.length > 0) { storedCanaries.push({ file: path.relative(kimiHome, path.join(file.parentPath, file.name)), markers }); }
  }
  await writeFile(path.join(out, "report.json"), JSON.stringify({ version, facts, storedCanaries }, null, 2));
  await fixture.stop();
  http.stop();
}
