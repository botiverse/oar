/** Native daemon only, isolated synthetic identity and native fake model replies. */
/* oxlint-disable import/max-dependencies -- Compose native transport, synthetic fixture and process observations. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnLineProcess } from "../../packages/oar/src/shared/executable/index.js";
import { readProcessTable, descendantsOf, killEntries, type ProcessEntry } from "../../packages/oar/src/shared/executable/process-tree.js";
import { asRecord, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { qoderInstallation } from "../../packages/oar/src/runtimes/qoder/installation.js";
import { qoderControl } from "../../packages/oar/src/runtimes/qoder/control.js";
import { startQoderNative, type QoderReply } from "../../sea-trial/harness/qoder-native.js";
import { rootsSince } from "./resources.js";
import { executableInstallation } from "../../packages/oar/src/shared/installation.js";
import { ProbeTiming, probeTimeout } from "./observation.js";

interface Connection {
  readonly child: ReturnType<typeof spawnLineProcess>;
  readonly control: ReturnType<typeof qoderControl>;
  readonly controls: ReturnType<typeof qoderControl>[];
  readonly turns: Map<string, ReturnType<typeof Promise.withResolvers<JsonRecord>>>;
  readonly root: ProcessEntry;
  readonly timing: ProbeTiming;
}

async function turn(connection: Connection, id: string): Promise<JsonRecord> {
    const result = Promise.withResolvers<JsonRecord>(); assert.ok(!connection.turns.has(id)); connection.turns.set(id, result);
    const limit = probeTimeout(60_000);
    try { connection.child.write(`${JSON.stringify({ type: "user", session_id: id, uuid: randomUUID(), message: { role: "user", content: "Return the fixture response" } })}\n`); return await connection.timing.wait(result.promise, `turn ${id}`, limit); }
    finally { connection.turns.delete(id); }
  }

// oxlint-disable-next-line typescript/explicit-function-return-type -- Export the inferred fixture shape below.
export async function qoderFixture(timing = new ProbeTiming()) {
  const installation = await timing.measure("installation", null, async () => { const value = process.platform === "win32"
    ? await executableInstallation("OAR_QODER_BIN", "qodercli", [], undefined, { versionTimeoutMs: 60_000 })()
    : await qoderInstallation(); return value; }); assert.ok(installation.kind === "available" && installation.via === "executable");
  const fixture = await startQoderNative([]);
  const children: ReturnType<typeof spawnLineProcess>[] = [];
  const crashDescendants: ProcessEntry[] = [];
  const frames: JsonRecord[] = [];
  const cleared = Object.fromEntries(Object.keys(process.env).map((key) => [key, undefined]));
  const env = { ...cleared, ...Object.fromEntries(Object.entries(process.env).filter(([key]) => ["path", "systemroot", "windir", "comspec", "pathext", "temp", "tmp"].includes(key.toLowerCase()))),
    ...fixture.options.env, QODER_AGENT_SDK_DAEMON: "1", QODER_FAKE_STREAM_DELAY_MS: "100" };
  const createControl = (child: ReturnType<typeof spawnLineProcess>): ReturnType<typeof qoderControl> => {
    const control = qoderControl(child, () => {}, probeTimeout(60_000));
    return { ...control, request: async (request, ms = probeTimeout(60_000)) => {
      const value = await timing.measure(String(request.type ?? request.subtype), ms, async () => { const reply = await control.request(request, ms); return reply; }); return value; } };
  };
  const connect = async (): Promise<Connection> => {
    const before = readProcessTable();
    const child = spawnLineProcess(installation.command, ["--sdk"], { cwd: fixture.options.cwd, env, killTree: true }); children.push(child);
    const control = createControl(child); const controls = [control];
    const turns = new Map<string, ReturnType<typeof Promise.withResolvers<JsonRecord>>>();
    child.onLine((line) => {
      const frame = asRecord(parseJson(line)); if (!frame || controls.some((entry) => entry.consume(frame))) { return; }
      frames.push(frame); if (frame.type === "result" && typeof frame.session_id === "string") { turns.get(frame.session_id)?.resolve(frame); }
    });
    child.onExit(() => { for (const entry of controls) { entry.end(); } for (const pendingTurn of turns.values()) { pendingTurn.reject(new Error("Qoder daemon exited")); } });
    await timing.wait(child.spawned, "daemon spawn");
    await control.request({ type: "daemon.initialize", daemon_protocol_version: 2, sdk_version: "oar-evidence", capabilities: ["multi_session_v2"], auth: { type: "qodercli" } });
    const roots = rootsSince(before); assert.equal(roots.length, 1); const [root] = roots; assert.ok(root);
    // npm's Windows shim is resolved before launch: the root Node process is the daemon.
    // An arbitrary first child can be a transient helper whose PID gets reused.
    return { child, control, controls, turns, root, timing };
  };
  const open = async (connection: Connection, options: { cwd: string; replies: readonly QoderReply[]; extra?: readonly string[]; resume?: string }): Promise<{ id: string; control: ReturnType<typeof qoderControl>; opened: JsonRecord }> => {
    const { cwd, replies, extra = [], resume } = options;
    const id = resume ?? randomUUID(); const file = path.join(fixture.home, `${randomUUID()}.jsonl`);
    await writeFile(file, `${replies.map((reply) => JSON.stringify({ method: "generateContentStream", response: (reply.chunks ?? [reply.text ?? "ok"]).map((text) => ({
      candidates: [{ content: { parts: reply.tool ? [{ functionCall: reply.tool }] : [{ text }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
    })) })).join("\n")}\n`, { mode: 0o600 });
    const launch = fixture.options.launchArgs ?? []; const fake = launch.indexOf("--fake-responses"); assert.ok(fake !== -1);
    const args = [...launch]; args[fake + 1] = file;
    const opened = await connection.control.request({ type: "daemon.open_session", cwd, worker_args: ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages", "--replay-user-messages",
      resume === undefined ? "--session-id" : "--resume", id, "--permission-mode", "bypass_permissions", "--permission-prompt-tool", "stdio", ...args, ...extra] });
    assert.equal(opened.session_id, id);
    const control = createControl({ ...connection.child, write(text) {
      const frame = asRecord(parseJson(text)); assert.ok(frame); connection.child.write(`${JSON.stringify({ ...frame, session_id: id })}\n`);
    } });
    connection.controls.push(control); await control.request({ subtype: "initialize" });
    return { id, control, opened };
  };
  return { timing, home: fixture.home, installation, frames, connect, open, turn,
    crash(connection: Connection): { identity: ProcessEntry; at: string; monotonicMs: number } {
      const table = readProcessTable(); assert.equal(table.get(connection.root.pid)?.start, connection.root.start, "daemon PID identity changed before fault injection");
      crashDescendants.push(...descendantsOf(table, connection.root.pid));
      const fault = { identity: connection.root, at: new Date().toISOString(), monotonicMs: performance.now() };
      process.kill(connection.root.pid, "SIGKILL"); return fault;
    },
    async stop(): Promise<void> {
      killEntries(crashDescendants, readProcessTable());
      await Promise.all(children.map(async (child) => { child.kill(); await child.exited; })); await fixture.stop();
    },
  };
}
export type QoderFixture = Awaited<ReturnType<typeof qoderFixture>>;
