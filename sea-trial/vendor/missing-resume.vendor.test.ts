import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { codexRuntime, piRuntime, SessionNotFoundError, type Runtime } from "../../packages/oar/src/index.js";
import { startCodexAimock, startPiAimock } from "../harness/aimock.js";
import { runtimeUnderTest } from "../harness/subject.js";

async function missing(runtime: Runtime, id: string, env?: Readonly<Record<string, string>>) {
  return runtimeUnderTest(runtime, env).startSession({ resume: id }).then(
    async (session) => { await session.dispose(); return session; },
    (error: unknown) => error,
  );
}

test.skipIf(process.env.OAR_TEST !== "codex-aimock")("Codex missing rollout rejects with the public error before a model request", async () => {
  const provider = await startCodexAimock();
  try {
    const id = randomUUID();
    const failure = await missing(codexRuntime, id, provider.env);
    expect(failure).toBeInstanceOf(SessionNotFoundError);
    expect(failure).toMatchObject({ sessionId: id, cause: { method: "thread/resume", native: { code: -32_600, message: `no rollout found for thread id ${id}` } } });
    expect(provider.mock.getRequests()).toEqual([]);
  } finally { await provider.stop(); }
}, 120_000);

test.skipIf(process.env.OAR_TEST !== "pi-aimock")("Pi missing file rejects with the public error and the searched cwd", async () => {
  const provider = await startPiAimock();
  try {
    const id = randomUUID();
    const failure = await missing(piRuntime, id);
    expect(failure).toBeInstanceOf(SessionNotFoundError);
    expect(failure).toMatchObject({ sessionId: id, cause: { method: "SessionManager.list", native: { cwd: process.cwd(), sessionCount: 0 } } });
    expect(provider.mock.getRequests()).toEqual([]);
  } finally { await provider.stop(); }
}, 120_000);
