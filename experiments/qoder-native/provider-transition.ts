/**
 * Inspect native model identity and replay-file use without an account or
 * external connections. Only selected protocol fields leave the fixture.
 * Run: pnpm tsx experiments/qoder-native/provider-transition.ts BIN VERSION MODE
 * MODE: catalog, valid, missing, malformed.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { qoderControl, qoderInitializeTimeoutMs } from "../../packages/oar/src/runtimes/qoder/control.js";
import { closeQoder, launchQoder } from "../../packages/oar/src/runtimes/qoder/launch.js";
import { asRecord, asRecordList, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { startQoderNative } from "../../sea-trial/harness/qoder-native.js";

const [command, version, mode] = process.argv.slice(2);
assert.ok(command !== undefined && path.isAbsolute(command) && version !== undefined);
assert.ok(["catalog", "valid", "missing", "malformed"].includes(mode ?? ""));
const fixture = await startQoderNative([{ text: "OAR_REPLAY_SENTINEL", input: 17, output: 3 }]);
const replay = path.join(fixture.home, "responses.jsonl");
const io = path.join(fixture.home, "io.jsonl");
const guard = fileURLToPath(new URL("replay-io-guard.mjs", import.meta.url));
const options = { ...fixture.options, env: { ...fixture.options.env,
  NODE_OPTIONS: `--import=${guard}`, OAR_QODER_PROBE_REPLAY: replay, OAR_QODER_PROBE_IO: io,
}, ...(mode === "catalog" ? { model: process.env.OAR_QODER_PROBE_MODEL ?? "efficient" } : {}) };
const frames: JsonRecord[] = [];
const rows: unknown[] = [];
let result: JsonRecord | null = null;
let failure: string | null = null;
try {
  if (mode === "missing") { await rm(replay); }
  if (mode === "malformed") { await writeFile(replay, "this is not json\n"); }
  const id = randomUUID();
  const child = await launchQoder(command, id, options, version);
  const control = qoderControl(child, () => {});
  const finished = Promise.withResolvers<JsonRecord>();
  // eslint-disable-next-line promise/prefer-await-to-then, unicorn/prefer-top-level-await -- Exit can reject before initialize returns and the main waiter starts.
  void finished.promise.catch(() => {});
  child.onLine(line => {
    const frame = asRecord(parseJson(line));
    if (frame === null || control.consume(frame)) { return; }
    frames.push(frame);
    if (frame.type === "result") { finished.resolve(frame); }
  });
  child.onExit(() => { control.end(); finished.reject(new Error("Native child exited before a result")); });
  let timer: NodeJS.Timeout | null = null;
  try {
    await control.request({ subtype: "initialize" }, qoderInitializeTimeoutMs);
    if (mode === "catalog") {
      for (const fetchStrategy of ["cache", "live"]) {
        // eslint-disable-next-line no-await-in-loop
        const answer = await control.request({ subtype: "get_models", fetchStrategy });
        const payload = asRecord(asRecord(answer.response)?.response);
        rows.push({ fetchStrategy, models: asRecordList(payload?.models).map(m => ({
          value: m.value, modelId: m.modelId, displayName: m.displayName,
          nativeName: asRecord(m.serverModel)?.display_name ?? null,
        })) });
      }
    } else {
      timer = setTimeout(() => { finished.reject(new Error("Native result deadline exceeded")); }, 45_000);
      child.write(`${JSON.stringify({ type: "user", session_id: id, uuid: randomUUID(), message: { role: "user", content: "read the synthetic reply" } })}\n`);
      result = await finished.promise;
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    if (timer !== null) { clearTimeout(timer); }
    control.end(); await closeQoder(child);
  }
  const observedText = await readFile(io, "utf8");
  const observations = observedText.trim().split("\n").map(line => asRecord(JSON.parse(line)));
  const text = JSON.stringify(frames);
  console.log(JSON.stringify({ version, mode, requested: options.model ?? null,
    initModel: frames.find(f => f.type === "system" && f.subtype === "init")?.model ?? null,
    rows, result: result === null ? null : { subtype: result.subtype, is_error: result.is_error,
      error_code: result.error_code, usage: result.usage },
    sawReplaySentinel: text.includes("OAR_REPLAY_SENTINEL"),
    errors: { missingFile: text.includes("ENOENT"), malformedJson: /Unexpected token|JSON\.parse|not valid JSON/u.test(text) },
    io: { guardLoads: observations.filter(o => o?.kind === "guard_loaded").length,
      replayReads: observations.filter(o => o?.kind === "replay_read").length,
      externalSocketsBlocked: observations.filter(o => o?.kind === "external_socket_blocked").length },
    ...(failure === null ? {} : { failure: failure.replaceAll(fixture.home, "<fixture>") }),
  }, null, 2));
} finally { await fixture.stop(); }
