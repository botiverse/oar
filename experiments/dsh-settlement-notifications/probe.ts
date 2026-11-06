/* oxlint-disable eslint/no-await-in-loop -- A finite sequence of native cases with independent processes and file gates. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { awaitTurnEnd } from "../../packages/oar/src/index.js";
import { asRecord, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { eventsOf, say, withDshFixture } from "../../sea-trial/vendor/support/dsh-fixture.js";
import { durableEvents, lastInput, type ProviderRequest, type Reply } from "../../sea-trial/vendor/support/dsh-provider.js";

const [output, selected] = process.argv.slice(2);
assert.ok(output !== undefined && output.length > 0, "pass an output directory");
await mkdir(output, { recursive: true });
const observer = fileURLToPath(new URL("observer.mjs", import.meta.url));
const cases = ["wake", "kill", "collected", "quiet", "budget", "child", "child-quiet", "child-interrupt"] as const;
assert.ok(selected === undefined || cases.some(kind => kind === selected), `unknown case: ${String(selected)}`);
interface Row { kind: string; data: JsonRecord; agents: JsonRecord[] }
interface Snapshot {
  label: string;
  at: number;
  rootEnds: number;
  requests: number;
  status: unknown;
  native: JsonRecord | undefined;
}
function record(value: unknown): JsonRecord {
  const result = asRecord(value);
  assert.ok(result !== null, "expected a native object");
  return result;
}
function list(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), "expected a native list");
  const result: unknown[] = value;
  return result;
}
async function rows(file: string): Promise<Row[]> {
  let text = "";
  try { text = await readFile(file, "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") { return []; }
    throw error;
  }
  return text.trim().split("\n").filter(Boolean).map(line => {
    const row = record(parseJson(line));
    assert.ok(typeof row.kind === "string");
    return { kind: row.kind, data: record(row.data), agents: list(row.agents).map(value => record(value)) };
  });
}
async function until(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const end = Date.now() + 20_000;
  while (!await predicate()) { assert.ok(Date.now() < end, `not observed: ${label}`); await delay(20); }
}
function latestToolId(request: ProviderRequest): string {
  const last = request.messages.findLast(message => message.role === "tool");
  const id = /bash-[a-f0-9]+|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/u.exec(JSON.stringify(last?.content))?.[0];
  assert.ok(id !== undefined, `no native job/child id in ${JSON.stringify(last)}`);
  return id;
}
function shell(index: number): Reply {
  return { kind: "tool", name: "bash", arguments: {
    description: `held job ${String(index)}`,
    command: `while [ ! -f 'release-${String(index)}' ]; do sleep 0.02; done; printf 'JOB_${String(index)}_DONE\\n'`,
    run_in_background: true,
  } };
}

for (const kind of cases.filter(candidate => selected === undefined || selected === candidate)) {
  const directory = path.resolve(output, kind);
  await mkdir(directory, { recursive: true });
  const observedFile = path.join(directory, "observer.jsonl");
  await writeFile(observedFile, "");
  let requests = 0;
  let controlSent = false;
  let secondStarted = false;
  const isChild = kind.startsWith("child");
  const config: JsonRecord = {};
  if (kind === "quiet" || kind === "child-quiet") { config.completionDelivery = "quiet"; }
  if (kind === "budget") { config.maxConsecutiveWakes = 1; }
  await withDshFixture((request) => {
    const input = lastInput(request);
    if (input.includes("NOTICE_CHILD")) { return { kind: "hold", text: "child complete" }; }
    requests += 1;
    if (requests === 1) {
      return isChild ? { kind: "tool", name: "subagent", arguments: { description: "held child", prompt: "NOTICE_CHILD" } } : shell(1);
    }
    if (requests === 2 && ["kill", "collected", "child-interrupt"].includes(kind)) {
      controlSent = true;
      const id = latestToolId(request);
      return kind === "child-interrupt"
        ? { kind: "tool", name: "interrupt_agent", arguments: { agent_id: id } }
        : { kind: "tool", name: kind === "kill" ? "job_kill" : "job_output", arguments: { job_id: id, ...(kind === "collected" ? { wait: true, timeout_ms: 15_000 } : {}) } };
    }
    if (kind === "budget" && !input.includes("NOTICE_ROOT") && !input.includes("HOST_WAKE") && !secondStarted) {
      secondStarted = true;
      return shell(2);
    }
    return say(`finished ${kind} request ${String(requests)}`);
  }, async ({ open, provider, aimock, installation }) => {
    assert.ok(installation.via === "executable");
    const session = await open();
    const root = session.id;
    const ends = (): number => eventsOf(session.records(), root).filter(event => event.kind === "turn_ended").length;
    const snapshots: Snapshot[] = [];
    const snapshot = async (label: string): Promise<void> => {
      const observed = await rows(observedFile);
      snapshots.push({ label, at: Date.now(), rootEnds: ends(), requests, status: session.status().value,
        native: observed.at(-1)?.agents.find((agent: JsonRecord) => agent.id === root) });
    };
    const nativeSettles = async (): Promise<number> => {
      const observed = await rows(observedFile);
      return observed.filter(row => row.kind === "jobs-live" && row.data.type === "settled").length;
    };
    const started = await session.prompt("NOTICE_ROOT", { inputId: "00000000-0000-4000-8000-000000000201" });
    assert.equal(started.kind, "accepted");
    if (kind === "collected") {
      await until(() => controlSent, "job_output request");
      // The evidence must then prove a live wait was released, not merely a delayed read.
      await delay(100);
      await writeFile(path.join(aimock.cwd, "release-1"), "go");
    }
    assert.deepEqual(await awaitTurnEnd(session, started.seq), { kind: "completed" });
    await snapshot("first-root-ended");
    if (kind === "kill") {
      await until(async () => await nativeSettles() === 1, "killed job settlement");
    } else if (isChild) {
      if (kind !== "child-interrupt") { await provider.held(); provider.release(); }
      await until(async () => {
        const observed = await rows(observedFile);
        return observed.some(row => row.kind === "subagent/end");
      }, "child end");
      if (kind !== "child-interrupt") { await until(() => ends() === 2, "parent notification turn"); }
    } else if (kind !== "collected") {
      await writeFile(path.join(aimock.cwd, "release-1"), "go");
      await until(async () => await nativeSettles() === 1, "first job settlement");
      if (kind === "wake" || kind === "budget") { await until(() => ends() === 2, "first wake turn"); }
      if (kind === "budget") {
        assert.equal(secondStarted, true);
        await writeFile(path.join(aimock.cwd, "release-2"), "go");
        await until(async () => await nativeSettles() === 2, "second job settlement");
      }
    }
    // A bounded observation is reported as such; source inspection establishes the no-wake branch.
    await delay(500);
    await snapshot("after-settlement-500ms");
    const beforeWake = await rows(observedFile);
    const rootEvents = beforeWake.filter(row => row.kind === "session-event" && row.data.sessionId === root).map(row => record(row.data.event));
    const notices = rootEvents.filter(event => event.type === "agent/inbox/spliced")
      .flatMap(event => list(record(event.data).inserted).map(value => record(value)))
      .filter(message => {
        const source = record(message.source);
        return source.kind === "tool-jobs" || source.kind === "subagent-settled";
      });
    const liveSettles = beforeWake.filter(row => row.kind === "jobs-live" && row.data.type === "settled");
    if (kind === "kill" || kind === "collected") { assert.equal(notices.length, 0); assert.equal(ends(), 1); }
    if (kind === "collected") { assert.equal(liveSettles[0]?.data.awaited, true); }
    if (kind === "quiet" || kind === "budget") {
      const pending = snapshots.at(-1)?.native;
      assert.ok(pending !== undefined);
      assert.equal(pending.status, "idle");
      assert.equal(list(pending.nextStep).length, 1);
      assert.equal(list(pending.nextTurn).length, 0);
      assert.equal(ends(), kind === "quiet" ? 1 : 2);
      const wake = await session.prompt("HOST_WAKE");
      assert.deepEqual(await awaitTurnEnd(session, wake.seq), { kind: "completed" });
      await snapshot("after-host-wake");
    }
    const summary = { kind, version: installation.version, root, config, snapshots, rootEnds: ends(), rootRequests: requests,
      notices: notices.map(message => ({ id: message.id, source: message.source })),
      liveSettles: liveSettles.map(row => ({ id: record(row.data.job).id, status: record(row.data.job).status, cause: row.data.cause, awaited: row.data.awaited })),
    };
    await writeFile(path.join(directory, "before-dispose.json"), JSON.stringify({ summary, records: session.records(), requests: provider.requests }, null, 2));
    await session.dispose();
    const durable = await durableEvents(aimock.home, root);
    await writeFile(path.join(directory, "durable.json"), JSON.stringify(durable, null, 2));
    await writeFile(path.join(directory, "summary.json"), JSON.stringify(summary, null, 2));
    process.stdout.write(`${JSON.stringify({ kind, version: installation.version, rootEnds: ends(), notices: notices.length, liveSettles: summary.liveSettles })}\n`);
  }, { homePatch: [{ id: "tool-jobs", config }, { insert: [{ id: "settlement-observer", name: observer, config: { output: observedFile } }] }] });
}
