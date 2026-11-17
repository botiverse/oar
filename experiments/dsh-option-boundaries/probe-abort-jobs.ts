import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { asRecord, asRecordList, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { say, untilCount, withDshFixture } from "../../sea-trial/vendor/support/dsh-fixture.js";
import { lastInput } from "../../sea-trial/vendor/support/dsh-provider.js";
import { withNativeProbe } from "./native-probe.js";

assert.equal(process.platform, "linux", "process liveness control measured only on Linux");
const output = path.resolve(process.argv[2] ?? "oar-trial-run/dsh-abort-jobs.json");
const root = "11111111-1111-4111-8111-111111111111";
const peer = "22222222-2222-4222-8222-222222222222";
const sent = new Set<string>();
let cancelled = false;
const source = `async probe(request) {
  owned(request.sessionId);
  const jobs = ctx.get("jobs");
  if (request.op === "kill") return { result: jobs.kill(request.jobId, request.sessionId, "OAR native probe") };
  if (request.op === "wait") return { job: await jobs.wait(request.jobId, 5000, request.sessionId) };
  return { jobs: jobs.list(request.sessionId) };
},`;
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { if (asRecord(error)?.code === "ESRCH") {return false;} throw error; }
};
await withDshFixture((request) => {
  const input = lastInput(request);
  const marker = ["PEER_JOB", "OLD_JOB", "ABORT_JOB"].find((entry) => input.includes(entry));
  if (marker !== undefined && !sent.has(marker)) {
    sent.add(marker);
    return { kind: "tool", name: "bash", arguments: { description: marker, command: `echo $$ > ${marker}.pid; while [ ! -f release-jobs ]; do sleep 0.05; done`, run_in_background: true } };
  }
  if (marker === "ABORT_JOB" && !cancelled) {return { kind: "hold", text: "job started" };}
  return say("usable");
}, async (fixture) => {
  assert.ok(fixture.installation.via === "executable");
  const result: JsonRecord = { version: fixture.installation.version };
  try {
    await withNativeProbe(fixture, { source, rows: [] }, async (control, frames) => {
      result.frames = frames;
      const ends = (sessionId: string): number => frames.filter((frame) => frame.sessionId === sessionId && asRecord(frame.event)?.type === "turn/end").length;
      await control.request("open", { sessionId: root, cwd: fixture.aimock.cwd });
      await control.request("open", { sessionId: peer, cwd: fixture.aimock.cwd });
      await control.request("prompt", { sessionId: peer, text: "PEER_JOB" });
      await untilCount(() => ends(peer), 1);
      assert.equal(ends(peer), 1);
      await control.request("prompt", { sessionId: root, text: "OLD_JOB" });
      await untilCount(() => ends(root), 1);
      assert.equal(ends(root), 1);
      const previousReply = await control.request("probe", { sessionId: root });
      const previous = asRecordList(previousReply.jobs);
      result.previous = previous;
      await control.request("prompt", { sessionId: root, text: "ABORT_JOB" });
      await fixture.provider.held();
      const beforeReply = await control.request("probe", { sessionId: root });
      const before = asRecordList(beforeReply.jobs);
      result.before = before;
      const current = before.find((job) => !previous.some((old) => old.id === job.id));
      assert.ok(current !== undefined);
      const names = ["PEER_JOB", "OLD_JOB", "ABORT_JOB"];
      await untilCount(() => names.filter((name) => existsSync(path.join(fixture.aimock.cwd, `${name}.pid`))).length, 3);
      const pids = await Promise.all(names.map(async (name) => Number(await readFile(path.join(fixture.aimock.cwd, `${name}.pid`), "utf8"))));
      assert.ok(pids.every((pid) => Number.isSafeInteger(pid) && pid > 1 && alive(pid)));
      await control.request("cancel", { sessionId: root });
      await untilCount(() => ends(root), 2);
      assert.equal(ends(root), 2);
      result.afterCancel = await control.request("probe", { sessionId: root });
      assert.ok(pids.every((pid) => alive(pid)), "cancel alone should leave these observed jobs alive");
      result.cancelLeftAllAlive = true;
      cancelled = true;
      result.kill = await control.request("probe", { sessionId: root, op: "kill", jobId: current.id });
      result.settled = await control.request("probe", { sessionId: root, op: "wait", jobId: current.id });
      assert.equal(asRecord(asRecord(result.settled)?.job)?.status, "killed");
      const [peerPid, oldPid, currentPid] = pids;
      assert.ok(peerPid !== undefined && oldPid !== undefined && currentPid !== undefined);
      await untilCount(() => alive(currentPid) ? 0 : 1, 1, 5000);
      assert.equal(alive(currentPid), false);
      assert.equal(alive(peerPid), true);
      assert.equal(alive(oldPid), true);
      result.selectedJobGoneOtherJobsAlive = true;
      // Settlement can enqueue a native job-completion turn. Wait for it before a host prompt.
      await untilCount(() => frames.filter((frame) => frame.sessionId === root && frame.status === "idle").length, 3);
      const reply = await control.request("queue", { sessionId: root, text: "AFTER_CLEANUP" });
      result.nextPrompt = reply;
      await untilCount(() => fixture.provider.sent("AFTER_CLEANUP") ? 1 : 0, 1);
      assert.equal(fixture.provider.sent("AFTER_CLEANUP"), true);
    });
    result.passed = true;
  } finally {
    await writeFile(path.join(fixture.aimock.cwd, "release-jobs"), "release");
    result.requests = fixture.provider.requests;
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(result, null, 2));
  }
});
console.log(JSON.stringify({ output, passed: true }));
