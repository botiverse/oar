/* oxlint-disable eslint/max-statements, import/max-dependencies -- Real two-session lifecycle scenarios retain related assertions and process/record helpers together. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { SessionUnavailableError } from "../../packages/oar/src/contracts/session-unavailable-error.js";
import { promptAndWait, awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { cleanupAcpOwner } from "../../packages/oar/src/shared/acp/shared-session.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";

import { fixture, opening, text } from "../fixtures/acp-shared-support.js";

function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

test("two simultaneous opens initialize once, keep cwd and MCP isolated, and route crossed answers", async () => {
  const f = await fixture();
  const [a, b] = await Promise.all([f.open("a", { mcpServers: [{ name: "a", command: "node", args: [] }] }), f.open("b", { mcpServers: [{ name: "b", command: "node", args: [] }] })]);
  expect(opening(a)?.pid).toBe(opening(b)?.pid); expect(opening(a)?.initialized).toBe(1); expect(opening(b)?.initialized).toBe(1);
  expect(opening(a)?.servers).toEqual(["a"]); expect(opening(b)?.servers).toEqual(["b"]);
  const results = await Promise.all([promptAndWait(a, "hello-a"), promptAndWait(b, "hello-b")]);
  expect(results.map(result => result.kind)).toEqual(["ended", "ended"]);
  expect(text(a)).toContain(`hello-a:${path.join(f.cwd, "a")}`); expect(text(a)).not.toContain("hello-b");
  expect(text(b)).toContain(`hello-b:${path.join(f.cwd, "b")}`); expect(text(b)).not.toContain("hello-a");
  expect(text(a)).toContain(`early:${a.id}`); expect(text(b)).toContain(`early:${b.id}`);
  expect(a.placement).toBe("shared"); expect(b.placement).toBe("shared");
});

test("permission and late multi-level child traffic stay with their native root", async () => {
  const f = await fixture(); const [a, b] = await Promise.all([f.open("a"), f.open("b")]);
  await Promise.all([promptAndWait(a, "permission"), promptAndWait(b, "permission")]);
  expect(text(a)).toContain(`allow-${a.id}`); expect(text(a)).not.toContain(`allow-${b.id}`);
  await promptAndWait(a, "child");
  expect(a.records().filter(record => record.sessionId.endsWith("grandchild"))).toHaveLength(1);
  expect(b.records().some(record => record.sessionId !== b.id)).toBe(false);
  expect(a.graph().edges).toEqual(expect.arrayContaining([
    { parent: a.id, child: `${a.id}-child`, via: "tool_call" },
    { parent: `${a.id}-child`, child: `${a.id}-grandchild`, via: "tool_call" },
  ]));
  const permission = a.records().find(record => record.kind === "request" && record.direction === "toApp" && record.sessionId === `${a.id}-child`);
  expect(permission?.kind).toBe("request");
  const requestId = permission?.kind === "request" ? permission.id : null;
  expect(a.records().find(record => record.kind === "response" && record.requestId === requestId)?.sessionId).toBe(`${a.id}-child`);
  expect(text(a)).toContain(`allow-${a.id}-child`);
  await promptAndWait(b, "unowned-host");
  expect(text(b)).toContain("unowned-refused"); expect(f.diagnostics).toMatchObject([{ method: "terminal/create", reason: "expired" }]);
  expect([...a.records(), ...b.records()].some(record => record.kind === "request" && record.direction === "toApp" && record.body.kind === "native" && asRecord(record.body.native)?.sessionId === "unowned")).toBe(false);
});

test("controlled native ids report in_use without sending resume or closing another controller", async () => {
  const f = await fixture(); const [a, b] = await Promise.all([f.open("a"), f.open("b")]);
  await expect(f.open("duplicate", { resume: a.id })).rejects.toBeInstanceOf(SessionUnavailableError);
  await expect(f.open("duplicate-shared", { resume: a.id }, "shared")).rejects.toMatchObject({ reason: "in_use", sessionId: a.id, cause: { method: "oar/open", native: { sessionId: a.id } } });
  const result0 = await promptAndWait(a, "still-alive"); expect(result0.kind).toBe("ended");
  await promptAndWait(b, "resume-count"); expect(text(b)).toContain("resume-count:0");
});

test("retired id auto-resume opens isolated before sending; explicit shared reports placement refusal", async () => {
  const f = await fixture(); const [a, b] = await Promise.all([f.open("a"), f.open("b")]);
  await a.dispose();
  await expect(f.open("retired", { resume: a.id }, "shared")).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "placement" });
  const resumed = await f.open("retired-auto", { resume: a.id });
  expect(resumed.id).toBe(a.id); expect(resumed.placement).toBe("isolated");
  expect(opening(resumed, "session/resume")?.pid).not.toBe(opening(b)?.pid);
  expect(resumed.records().find(record => record.kind === "request" && record.body.kind === "open")?.body).toEqual({ kind: "open", placement: "auto" });
  expect(resumed.records().find(record => record.kind === "response" && record.body.kind === "opened")?.body).toEqual({ kind: "opened", placement: "isolated" });
  expect(await promptAndWait(resumed, "resumed")).toMatchObject({ kind: "ended" });
  await promptAndWait(b, "resume-count"); expect(text(b)).toContain("resume-count:0");
  const result1 = await promptAndWait(b, "still-peer"); expect(result1.kind).toBe("ended");
  expect(a.records().some(record => record.kind === "response" && record.body.kind === "released")).toBe(true);
  expect(a.records().some(record => record.kind === "response" && record.body.kind === "exited")).toBe(false);
});

test("native resume failure never retries in another process under auto", async () => {
  const f = await fixture(); const trace = path.join(f.cwd, "requests.jsonl"); const env = { FIXTURE_TRACE_FILE: trace };
  const a = await f.open("a", { env });
  await expect(f.open("resume-failure", { resume: "old-root", env })).rejects.toThrow("native resume refused");
  await promptAndWait(a, "resume-count"); expect(text(a)).toContain("resume-count:1");
  const traceText = await readFile(trace, "utf8");
  const requests = traceText.trim().split("\n").map(line => asRecord(JSON.parse(line)));
  expect(requests.filter(request => request?.method === "initialize")).toHaveLength(1);
  expect(requests.filter(request => request?.method === "session/resume")).toHaveLength(1);
  expect(await promptAndWait(a, "peer-survives")).toMatchObject({ kind: "ended" });
});

test("abort fallback releases one root; disposal cleans again, leaving peer usable", async () => {
  let cleanups = 0;
  const f = await fixture({ cleanup: async () => { cleanups += 1; } });
  const [a, b] = await Promise.all([f.open("a"), f.open("b")]);
  const prompt = await a.prompt("ignore-cancel"); await a.abort();
  expect(await awaitTurnEnd(a, prompt.request.seq)).toEqual({ kind: "aborted" });
  expect(cleanups).toBe(1); const result2 = await a.prompt("refused"); expect(result2.response.body).toMatchObject({ kind: "rejected", code: "session_released" });
  const result3 = await promptAndWait(b, "peer"); expect(result3.kind).toBe("ended");
  await a.dispose(); expect(cleanups).toBe(2);
  await b.dispose();
  expect(a.records().filter(record => record.kind === "response" && record.body.kind === "exited")).toHaveLength(0);
  expect(b.records().filter(record => record.kind === "response" && record.body.kind === "exited")).toHaveLength(1);
});

test("native cleanup failure still stops this root's hosted terminal and leaves its peer", async () => {
  const f = await fixture({ cleanup: async () => { throw new Error("native cleanup refused"); } });
  const [a, b] = await Promise.all([f.open("a"), f.open("b")]); await promptAndWait(a, "terminal");
  const pidFile = path.join(f.cwd, "a", `terminal-${a.id}.pid`);
  await expect.poll(async () => readFile(pidFile, "utf8").catch(() => "")).not.toBe("");
  const pid = Number(await readFile(pidFile, "utf8")); expect(alive(pid)).toBe(true);
  await a.dispose(); await expect.poll(() => alive(pid)).toBe(false);
  expect(a.records().some(record => record.kind === "response" && record.body.kind === "cleanup" && record.body.result.kind === "failed" && record.body.result.reason.includes("native cleanup refused"))).toBe(true);
  const result4 = await promptAndWait(b, "peer-survives"); expect(result4.kind).toBe("ended");
});

test("one process crash ends every active lease exactly once and never restarts them", async () => {
  const f = await fixture(); const [a, b] = await Promise.all([f.open("a"), f.open("b")]);
  const held = await a.prompt("hold"); await promptAndWait(b, "exit"); await awaitTurnEnd(a, held.request.seq);
  for (const session of [a, b]) { expect(session.records().filter(record => record.kind === "response" && record.body.kind === "exited")).toHaveLength(1); }
  const result5 = await a.prompt("after-exit"); expect(result5.response.body).toMatchObject({ kind: "rejected", code: "runtime_exited" });
});

test("a peer's MCP credential cannot enter another session's protocol error or records", async () => {
  const f = await fixture(); const secret = "peer-b-private-mcp-credential";
  const [a] = await Promise.all([f.open("a"), f.open("b", { mcpServers: [{ name: "b", command: "node", args: [], env: { API_KEY: secret } }] })]);
  await promptAndWait(a, "peer-secret-error");
  expect(JSON.stringify(a.records())).not.toContain(secret); expect(JSON.stringify(a.records())).toContain("[redacted]");
  expect(JSON.stringify(f.diagnostics)).not.toContain(secret);
});

test("buffered update time and usage replay boundary survive SDK parsing and late binding", async () => {
  const f = await fixture({}, { spontaneousTokenUsage: (method, params) => method === "fixture/usage" && typeof params.key === "string" ? { key: params.key, tokens: { input: 1, output: 0 } } : null });
  const a = await f.open("a");
  await promptAndWait(a, "settle");
  const early = a.records().find(record => record.kind === "frame" && record.body.type === "agent_message_chunk");
  const opened = a.records().find(record => record.kind === "frame" && record.body.type === "session/new");
  expect(early?.receivedAt).toBeLessThan(opened?.receivedAt ?? 0);
  const usage = a.records().filter(record => record.kind === "frame" && record.body.type === "fixture/usage");
  expect(usage.map(record => record.kind === "frame" ? record.body.events.length : -1)).toEqual([0, 1]);
});

test("connection settings and Runtime factory identity prevent accidental pool reuse", async () => {
  const f = await fixture({}, { initializeMeta: options => ({ root: options.cwd }) });
  const [a, b] = await Promise.all([f.open("a"), f.open("b")]);
  expect(opening(a)?.pid).not.toBe(opening(b)?.pid);
  const other = await fixture({ processCwd: () => f.cwd });
  const c = await other.open("a");
  expect(opening(c)?.pid).not.toBe(opening(a)?.pid);
  const d = await other.open("env", { env: { SHARED_CONFIGURATION: "different" } });
  expect(opening(d)?.pid).not.toBe(opening(c)?.pid);
});

test("session configuration failure cleans only its acquired id and leaves a peer usable", async () => {
  const f = await fixture({}, { configureSession: async ({ options }) => {
    await Promise.resolve();
    if (options.cwd.endsWith("failed")) { throw new Error("configuration refused"); }
  } });
  const a = await f.open("a");
  await expect(f.open("failed")).rejects.toThrow("configuration refused");
  const result = await promptAndWait(a, "session-count");
  expect(result.kind).toBe("ended"); expect(text(a)).toContain("count:1");
});

test("failed shared initialization rejects its waiters and a later open gets a new attempt", async () => {
  const f = await fixture();
  const results = await Promise.allSettled([f.open("a", { env: { FAIL_INIT: "1" } }), f.open("b", { env: { FAIL_INIT: "1" } })]);
  expect(results.map(result => result.status)).toEqual(["rejected", "rejected"]);
  const c = await f.open("c");
  expect(opening(c)?.initialized).toBe(1);
  expect(await promptAndWait(c, "new-process")).toMatchObject({ kind: "ended" });
});

test("resume reserves its native id before replay and refuses a concurrent controller", async () => {
  const f = await fixture(); const a = await f.open("a");
  const results = await Promise.allSettled([f.open("resume", { resume: "old-root" }), f.open("duplicate", { resume: "old-root" })]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  const resumed = results.find(result => result.status === "fulfilled");
  expect(resumed?.status === "fulfilled" ? text(resumed.value) : "").toContain("resume-replay");
  expect(text(a)).not.toContain("resume-replay");
});

test("a late native completion after release is recorded without a second turn ending", async () => {
  const f = await fixture({ cleanup: async () => { await Promise.resolve(); } });
  const [a, b] = await Promise.all([f.open("a"), f.open("b")]);
  const start = await a.prompt("late-after-release"); await a.abort();
  expect(await awaitTurnEnd(a, start.request.seq)).toEqual({ kind: "aborted" });
  await expect.poll(() => text(a)).toContain("late-native-text");
  await expect.poll(() => a.records().some(record => record.kind === "frame" && record.body.type === "session/prompt")).toBe(true);
  expect(a.records().flatMap(record => record.kind === "frame" ? record.body.events.filter(event => event.kind === "turn_ended") : [])).toEqual([]);
  expect(await promptAndWait(b, "still-live")).toMatchObject({ kind: "ended" });
});

test("host terminals stay partitioned even when a peer presents the real terminal id", async () => {
  const f = await fixture(); const [a, b] = await Promise.all([f.open("a"), f.open("b")]);
  await promptAndWait(a, "terminal");
  const pidFile = path.join(f.cwd, "a", `terminal-${a.id}.pid`);
  await expect.poll(async () => readFile(pidFile, "utf8").catch(() => "")).not.toBe("");
  const pid = Number(await readFile(pidFile, "utf8")); expect(alive(pid)).toBe(true);
  await promptAndWait(b, "terminal-peer"); expect(text(b)).toContain("peer-terminal-refused");
  await b.dispose(); expect(alive(pid)).toBe(true);
  await a.dispose(); await expect.poll(() => alive(pid)).toBe(false);
});

test("concurrent controls serialize only their root and disposal records one operation", async () => {
  const f = await fixture(); const [a, b] = await Promise.all([f.open("a"), f.open("b")]);
  const controls = await Promise.all([a.prompt("hold"), a.prompt("must-be-busy"), b.prompt("unblocked")]);
  expect(controls.map(control => control.response.body.kind)).toEqual(["accepted", "rejected", "accepted"]);
  expect(controls[1].response.body).toMatchObject({ code: "busy" });
  await Promise.all([a.dispose(), a.dispose()]);
  expect(a.records().filter(record => record.kind === "request" && record.body.kind === "dispose")).toHaveLength(1);
  expect(await awaitTurnEnd(b, controls[2].request.seq)).toMatchObject({ kind: "completed" });
  expect(await promptAndWait(b, "peer")).toMatchObject({ kind: "ended" });
});

test("peer credentials stay redacted in notifications, diagnostics and SDK malformed-frame logs after retirement", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const f = await fixture(); const secret = "retired-peer-mcp-credential";
    const [a, b] = await Promise.all([f.open("a"), f.open("b", { mcpServers: [{ name: "b", command: "node", args: [], env: { API_KEY: secret } }] })]);
    await b.dispose(); await promptAndWait(a, "peer-secret-update"); await promptAndWait(a, "peer-secret-malformed");
    expect(text(a)).toContain("[redacted]");
    expect(JSON.stringify([a.records(), f.diagnostics, error.mock.calls])).not.toContain(secret);
    expect(error.mock.calls.length).toBeGreaterThan(0);
  } finally { error.mockRestore(); }
});

test("bounded native cleanup does not skip terminals when native cleanup never resolves", async () => {
  let stopped = false;
  await expect(cleanupAcpOwner(async () => { await Promise.withResolvers<void>().promise; }, async () => { stopped = true; await Promise.resolve(); }, 20)).rejects.toThrow("native session cleanup timed out");
  expect(stopped).toBe(true);
});


test("native output EOF terminates the shared process and settles every lease", async () => {
  const f = await fixture(); const [a, b] = await Promise.all([f.open("a"), f.open("b")]);
  const held = await a.prompt("hold");
  expect(await promptAndWait(b, "connection-break")).toMatchObject({ kind: "ended" });
  await awaitTurnEnd(a, held.request.seq);
  for (const session of [a, b]) { expect(session.records().filter(record => record.kind === "response" && record.body.kind === "exited")).toHaveLength(1); }
});

test("release refuses a late native terminal request while retaining late output", async () => {
  const f = await fixture({ cleanup: async () => { await Promise.resolve(); } });
  const [a, b] = await Promise.all([f.open("a"), f.open("b")]);
  const start = await a.prompt("late-host-after-release"); await a.abort();
  expect(await awaitTurnEnd(a, start.request.seq)).toEqual({ kind: "aborted" });
  await expect.poll(() => text(a)).toContain("late-host-refused");
  expect(a.records().some(record => record.kind === "request" && record.direction === "toApp")).toBe(false);
  await expect(readFile(path.join(f.cwd, "a", "must-not-exist"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  expect(await promptAndWait(b, "peer-still-accepts-input")).toMatchObject({ kind: "ended" });
});
