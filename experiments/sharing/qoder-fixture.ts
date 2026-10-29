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

interface Connection {
  readonly child: ReturnType<typeof spawnLineProcess>;
  readonly control: ReturnType<typeof qoderControl>;
  readonly controls: ReturnType<typeof qoderControl>[];
  readonly turns: Map<string, ReturnType<typeof Promise.withResolvers<JsonRecord>>>;
  readonly root: ProcessEntry;
  readonly native: ProcessEntry;
}

async function turn(connection: Connection, id: string): Promise<JsonRecord> {
    const result = Promise.withResolvers<JsonRecord>(); assert.ok(!connection.turns.has(id)); connection.turns.set(id, result);
    const timer = setTimeout(() => { result.reject(new Error("Qoder turn timed out")); }, 60_000);
    try { connection.child.write(`${JSON.stringify({ type: "user", session_id: id, uuid: randomUUID(), message: { role: "user", content: "Return the fixture response" } })}\n`); return await result.promise; }
    finally { clearTimeout(timer); connection.turns.delete(id); }
  }

// oxlint-disable-next-line typescript/explicit-function-return-type -- Export the inferred fixture shape below.
export async function qoderFixture() {
  const installation = await qoderInstallation(); assert.ok(installation.kind === "available" && installation.via === "executable");
  const fixture = await startQoderNative([]);
  const children: ReturnType<typeof spawnLineProcess>[] = [];
  const crashDescendants: ProcessEntry[] = [];
  const frames: JsonRecord[] = [];
  const cleared = Object.fromEntries(Object.keys(process.env).map((key) => [key, undefined]));
  const env = { ...cleared, ...Object.fromEntries(Object.entries(process.env).filter(([key]) => ["path", "systemroot", "windir", "comspec", "pathext", "temp", "tmp"].includes(key.toLowerCase()))),
    ...fixture.options.env, QODER_AGENT_SDK_DAEMON: "1", QODER_FAKE_STREAM_DELAY_MS: "100" };
  const connect = async (): Promise<Connection> => {
    const before = readProcessTable();
    const child = spawnLineProcess(installation.command, ["--sdk"], { cwd: fixture.options.cwd, env, killTree: true }); children.push(child);
    const control = qoderControl(child, () => {}, 60_000); const controls = [control];
    const turns = new Map<string, ReturnType<typeof Promise.withResolvers<JsonRecord>>>();
    child.onLine((line) => {
      const frame = asRecord(parseJson(line)); if (!frame || controls.some((entry) => entry.consume(frame))) { return; }
      frames.push(frame); if (frame.type === "result" && typeof frame.session_id === "string") { turns.get(frame.session_id)?.resolve(frame); }
    });
    child.onExit(() => { for (const entry of controls) { entry.end(); } for (const pendingTurn of turns.values()) { pendingTurn.reject(new Error("Qoder daemon exited")); } });
    await child.spawned;
    await control.request({ type: "daemon.initialize", daemon_protocol_version: 2, sdk_version: "oar-evidence", capabilities: ["multi_session_v2"], auth: { type: "qodercli" } });
    const roots = rootsSince(before); assert.equal(roots.length, 1); const [root] = roots; assert.ok(root);
    const native = [...readProcessTable().values()].find((entry) => entry.ppid === root.pid) ?? root;
    return { child, control, controls, turns, root, native };
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
    const control = qoderControl({ ...connection.child, write(text) {
      const frame = asRecord(parseJson(text)); assert.ok(frame); connection.child.write(`${JSON.stringify({ ...frame, session_id: id })}\n`);
    } }, () => {}, 60_000);
    connection.controls.push(control); await control.request({ subtype: "initialize" });
    return { id, control, opened };
  };
  return { home: fixture.home, installation, frames, connect, open, turn,
    crash(connection: Connection): void {
      const table = readProcessTable(); assert.equal(table.get(connection.native.pid)?.start, connection.native.start);
      crashDescendants.push(...descendantsOf(table, connection.native.pid)); process.kill(connection.native.pid, "SIGKILL");
    },
    async stop(): Promise<void> {
      killEntries(crashDescendants, readProcessTable());
      await Promise.all(children.map(async (child) => { child.kill(); await child.exited; })); await fixture.stop();
    },
  };
}
export type QoderFixture = Awaited<ReturnType<typeof qoderFixture>>;
