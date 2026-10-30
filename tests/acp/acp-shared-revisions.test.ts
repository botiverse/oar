/* oxlint-disable eslint/max-statements -- Complete adversarial process lifecycles retain their observations together. */
import { expect, test, vi } from "vitest";
import { promptAndWait, awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { fixture, opening, text } from "../fixtures/acp-shared-support.js";

test("late successful session/new after timeout cleans and retires only that native id", async () => {
  const f = await fixture({}, { sessionStartTimeoutMs: 1000 }); const a = await f.open("a");
  const secret = "cancelled-open-mcp-secret";
  await expect(f.open("late-new", { mcpServers: [{ name: "late", command: "node", args: [], env: { API_KEY: secret } }] })).rejects.toThrow("timed out");
  await expect.poll(() => f.diagnostics.some(entry => entry.method === "cancelled_session_new_cleanup")).toBe(true);
  expect(f.diagnostics.find(entry => entry.method === "cancelled_session_new_cleanup")).toMatchObject({ params: { sessionId: "root-2", result: { kind: "completed" } } });
  expect(JSON.stringify(f.diagnostics)).not.toContain(secret);
  await promptAndWait(a, "session-count"); expect(text(a)).toContain("count:1");
  await expect(f.open("retired", { resume: "root-2" }, "shared")).rejects.toMatchObject({ option: "placement" });
  expect(await promptAndWait(a, "still-live")).toMatchObject({ kind: "ended" });
});

test("failed cleanup of a late new remains diagnostic and the id stays retired", async () => {
  const f = await fixture({ cleanup: async () => { throw new Error("cleanup refused"); } }, { sessionStartTimeoutMs: 1000 });
  const a = await f.open("a"); await expect(f.open("late-new")).rejects.toThrow("timed out");
  await expect.poll(() => f.diagnostics.some(entry => entry.method === "cancelled_session_new_cleanup")).toBe(true);
  expect(f.diagnostics.find(entry => entry.method === "cancelled_session_new_cleanup")).toMatchObject({ params: { result: { kind: "failed", reason: "cleanup refused" } } });
  await expect(f.open("retired", { resume: "root-2" }, "shared")).rejects.toMatchObject({ option: "placement" });
  expect(await promptAndWait(a, "peer")).toMatchObject({ kind: "ended" });
});

test.each(["collision", "late-collision"])("%s new id cannot clean or take over an existing peer", async mode => {
  const f = await fixture({}, { sessionStartTimeoutMs: 1000 }); const a = await f.open("a");
  if (mode === "collision") {
    await expect(f.open(`${mode}-${a.id}`)).rejects.toMatchObject({ name: "AcpProtocolError" });
  } else {
    await expect(f.open(`${mode}-${a.id}`)).rejects.toThrow("timed out");
    await expect.poll(() => f.diagnostics.some(entry => entry.method === "cancelled_session_new_collision")).toBe(true);
    expect(f.diagnostics.some(entry => entry.method === "cancelled_session_new_cleanup")).toBe(false);
  }
  expect(await promptAndWait(a, "still-controller")).toMatchObject({ kind: "ended" });
});

test("slow new preserves early native updates past the unknown-id expiry", async () => {
  const f = await fixture({ pending: { waitMs: 10 } }, { sessionStartTimeoutMs: 2000 });
  const a = await f.open("slow-new");
  expect(text(a)).toContain(`early:${a.id}`);
  expect(f.diagnostics).toEqual([]);
});

test("overlapping peer credentials redact prompts, host records, native failures and late diagnostics in full", async () => {
  const f = await fixture(); const short = "prefix-private-token"; const long = `${short}-more-secret-tail`;
  const a = await f.open("a", { mcpServers: [{ name: "a", command: "node", args: [], env: { API_KEY: short } }] });
  const b = await f.open("b", { mcpServers: [{ name: "b", command: "node", args: [], env: { API_KEY: long } }] });
  await promptAndWait(a, long); await promptAndWait(a, "peer-secret-error");
  await b.dispose(); await promptAndWait(a, "peer-secret-update");
  const retained = JSON.stringify([a.records(), f.diagnostics]);
  expect(retained).toContain("[redacted]"); expect(retained).not.toContain(short); expect(retained).not.toContain("more-secret-tail");
});


test.each(["initialize failure", "transport close"])("%s evicts before process shutdown so a concurrent open starts fresh", async mode => {
  if (mode === "transport close") { const { default: relayAcpOutput } = await import("../fixtures/acp-output-relay.js"); await relayAcpOutput(); }
  const processModule = await import("../../packages/oar/src/shared/acp/process.js");
  const start = processModule.startAcpProcess;
  const stopping = Promise.withResolvers<void>(); const shutdown: { release?: () => void } = {}; let first = true;
  const spy = vi.spyOn(processModule, "startAcpProcess").mockImplementation((...arguments_) => {
    const [command, args, app, options] = arguments_;
    if (!first) { return start(command, args, app, options); }
    first = false;
    const runtime = start(command, args, app, { ...options, incoming: message => {
      const forwarded = options?.incoming === undefined ? message : options.incoming(message);
      // oxlint-disable-next-line unicorn/no-useless-undefined -- Preserve an explicitly dropped wire frame.
      if (forwarded === undefined) { return undefined; }
      if (mode === "initialize failure" && "result" in forwarded && asRecord(forwarded.result)?.protocolVersion === 1) {
        return { jsonrpc: "2.0", id: forwarded.id, error: { code: -32_000, message: "first initialization refused" } };
      }
      return forwarded;
    } });
    const kill = runtime.kill.bind(runtime); shutdown.release = kill;
    runtime.kill = () => { stopping.resolve(); };
    return runtime;
  });
  try {
    const f = await fixture();
    if (mode === "initialize failure") {
      const rejected = expect(f.open("first")).rejects.toThrow("first initialization refused");
      await stopping.promise;
      const fresh = await f.open("fresh"); expect(await promptAndWait(fresh, "works")).toMatchObject({ kind: "ended" });
      shutdown.release?.(); await rejected;
    } else {
      const old = await f.open("first"); const prompt = await old.prompt("connection-break");
      await stopping.promise;
      // EOF must arrive while the original process is still alive, before kill is released.
      expect(() => { process.kill(Number(opening(old)?.pid), 0); }).not.toThrow();
      const fresh = await f.open("fresh");
      expect(opening(fresh)?.pid).not.toBe(opening(old)?.pid);
      expect(await promptAndWait(fresh, "works")).toMatchObject({ kind: "ended" });
      shutdown.release?.(); await awaitTurnEnd(old, prompt.request.seq);
    }
  } finally { shutdown.release?.(); spy.mockRestore(); }
});
