import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { start } from "../fixtures/acp-session-support.js";
import relayAcpOutput from "../fixtures/acp-output-relay.js";

test("SDK rejection of a native batch ends the isolated session without a host dispose", async () => {
  const session = await start({ args: [fileURLToPath(new URL("../fixtures/acp-invalid-batch.mjs", import.meta.url))] });
  try {
    const prompt = await session.prompt("invalid-batch");
    expect(prompt.response.body.kind).toBe("accepted");
    await expect.poll(() => session.records().filter(record => record.kind === "response" && record.body.kind === "exited"), { timeout: 5000 }).toHaveLength(1);
    expect(await awaitTurnEnd(session, prompt.request.seq)).toMatchObject({ kind: "failed", failure: "runtime_exited" });
    const after = await session.prompt("after-protocol-close");
    expect(after.response.body).toMatchObject({ kind: "rejected", code: "runtime_exited" });
  } finally { await session.dispose(); }
});

// oxlint-disable-next-line eslint/max-statements -- Observe the native EOF and later host disposal in one session lifetime.
test("normal ACP stdout EOF leaves native shutdown to the agent until host dispose", async () => {
  await relayAcpOutput();
  const processes = await import("../../packages/oar/src/shared/acp/process.js");
  const nativeStart = processes.startAcpProcess;
  const started: ReturnType<typeof nativeStart>[] = [];
  const spy = vi.spyOn(processes, "startAcpProcess").mockImplementation((...args) => {
    const runtime = nativeStart(...args); started.push(runtime); return runtime;
  });
  const session = await start({ args: [fileURLToPath(new URL("../fixtures/fake-acp-shared.mjs", import.meta.url))] });
  try {
    const prompt = await session.prompt("connection-break");
    expect(prompt.response.body.kind).toBe("accepted");
    const [runtime] = started;
    if (runtime === undefined) { throw new Error("native ACP process was not started"); }
    // Observe real EOF through the SDK, not a sleep that guesses relay startup.
    await runtime.connection.closed;
    expect(runtime.diagnostics().cleanup).toBeUndefined();
    expect(session.records().filter(record => record.kind === "response" && record.body.kind === "exited")).toHaveLength(0);
    await session.dispose();
    expect(session.records().filter(record => record.kind === "response" && record.body.kind === "exited")).toHaveLength(1);
    expect(await awaitTurnEnd(session, prompt.request.seq)).toEqual({ kind: "aborted" });
  } finally { await session.dispose(); spy.mockRestore(); }
});
