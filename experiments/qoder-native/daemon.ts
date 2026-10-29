/** Qoder 1.1.81 daemon routing, synthetic local identity and native fake responses.
 * Run: pnpm tsx experiments/qoder-native/daemon.ts /path/to/qodercli
 * No account credential, remote model request, or raw frame is printed.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnLineProcess } from "../../packages/oar/src/shared/executable/index.js";
import { sessionEnvironment } from "../../packages/oar/src/shared/environment.js";
import { asRecord, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { qoderControl } from "../../packages/oar/src/runtimes/qoder/control.js";
import { startQoderNative } from "../../sea-trial/harness/qoder-native.js";

const fixture = await startQoderNative([{ text: "FIRST" }, { text: "SECOND" }]);
const child = spawnLineProcess(process.argv[2] ?? "qodercli", ["--sdk"], {
  cwd: fixture.options.cwd, env: { ...sessionEnvironment(fixture.options.env), QODER_AGENT_SDK_DAEMON: "1" }, killTree: true,
});
const connection = qoderControl(child, () => {}, 60_000);
const controls = [connection];
const turns = new Map<string, (frame: JsonRecord) => void>();
child.onLine((line) => {
  const frame = asRecord(parseJson(line));
  if (frame === null || controls.some((control) => control.consume(frame))) { return; }
  if (frame.type === "result" && typeof frame.session_id === "string") { turns.get(frame.session_id)?.(frame); }
});
child.onExit(() => { for (const control of controls) { control.end(); } });
function sessionControl(sessionId: string): ReturnType<typeof qoderControl> {
  const control = qoderControl({ ...child, write(text) {
    const frame = asRecord(parseJson(text)); assert.ok(frame);
    child.write(`${JSON.stringify({ ...frame, session_id: sessionId })}\n`);
  } }, () => {}, 60_000);
  controls.push(control); return control;
}
async function open(id: string): Promise<ReturnType<typeof qoderControl>> {
  const answer = await connection.request({ type: "daemon.open_session", cwd: fixture.options.cwd,
    worker_args: ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--session-id", id,
      "--permission-mode", "bypass_permissions", "--permission-prompt-tool", "stdio", ...fixture.options.launchArgs ?? []] });
  assert.equal(answer.session_id, id);
  const control = sessionControl(id); await control.request({ subtype: "initialize" }); return control;
}
async function turn(id: string, expected: string): Promise<void> {
  const result = Promise.withResolvers<JsonRecord>();
  turns.set(id, result.resolve);
  const timer = setTimeout(() => { result.reject(new Error("Qoder daemon probe turn timed out")); }, 30_000);
  try {
    child.write(`${JSON.stringify({ type: "user", session_id: id, uuid: randomUUID(), message: { role: "user", content: "reply" } })}\n`);
    const frame = await result.promise;
    assert.equal(frame.session_id, id); assert.equal(frame.subtype, "success"); assert.equal(frame.result, expected);
  } finally { clearTimeout(timer); turns.delete(id); }
}
try {
  await child.spawned;
  await connection.request({ type: "daemon.initialize", daemon_protocol_version: 2, sdk_version: "oar-probe",
    capabilities: ["multi_session_v2"], auth: { type: "qodercli" } });
  const a = randomUUID(), b = randomUUID();
  const first = await open(a); const second = await open(b);
  await Promise.all([turn(a, "FIRST"), turn(b, "FIRST")]);
  await first.request({ type: "daemon.close_session" });
  await turn(b, "SECOND");
  await second.request({ type: "daemon.close_session" });
  await connection.request({ type: "daemon.shutdown" });
  process.stdout.write(`${JSON.stringify({ twoSessions: true, correctlyRoutedResults: 3, survivingSessionAfterPeerClose: true })}\n`);
} finally { child.kill(); await child.exited; await fixture.stop(); }
