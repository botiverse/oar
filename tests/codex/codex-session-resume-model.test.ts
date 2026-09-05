import { afterEach, expect, test, vi } from "vitest";
import { codexSession } from "../../packages/oar/src/runtimes/codex/session.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<(command: string, args: readonly string[]) => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));

const installation = { kind: "available", via: "executable", command: "codex", version: "0.153.4" } as const;
const threadId = "thread-123";

afterEach(() => {
  spawnLineProcess.mockReset();
});

interface Request {
  readonly id: number;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/**
 * A scripted app-server: answers initialize with `{}` and thread/start or
 * thread/resume with the thread id plus whatever model `activeModel` says is
 * really running. Records every request so tests can assert the wire shape.
 */
function fakeAppServer(activeModel: (request: Request) => string): { fake: FakeLineProcess; requests: Request[] } {
  const requests: Request[] = [];
  const fake = fakeLineProcess((text, process) => {
    const message = asRecord(JSON.parse(text));
    if (typeof message?.id !== "number" || typeof message.method !== "string") {
      return;
    }
    const request: Request = { id: message.id, method: message.method, params: asRecord(message.params) ?? {} };
    requests.push(request);
    const result = request.method === "initialize"
      ? {}
      : { thread: { id: threadId }, model: activeModel(request), modelProvider: "openai" };
    process.emit(`${JSON.stringify({ id: request.id, result })}\n`);
  });
  spawnLineProcess.mockReturnValue(fake);
  return { fake, requests };
}

test("thread/resume carries the requested model and the session resumes the same id", async () => {
  const { fake, requests } = fakeAppServer((request) => String(request.params.model));
  const session = await codexSession(installation, { cwd: "/work", resume: threadId, model: "gpt-5.5" });
  expect(session.id).toBe(threadId);
  const resume = requests.find((request) => request.method === "thread/resume");
  expect(resume?.params).toMatchObject({ threadId, cwd: "/work", model: "gpt-5.5", approvalPolicy: "never" });
  await session.dispose();
  expect(fake.killed()).toBe(true);
});

test("thread/resume without a model does not send one", async () => {
  const { requests } = fakeAppServer(() => "whatever-was-saved");
  const session = await codexSession(installation, { cwd: "/work", resume: threadId });
  const resume = requests.find((request) => request.method === "thread/resume");
  expect(resume?.params).not.toHaveProperty("model");
  await session.dispose();
});

// The case the owner asked tests to catch: the runtime accepts the request
// but keeps the old model (codex logs "thread/resume overrides ignored for
// loaded thread" and answers with the old model). An adapter that only
// forwards the parameter would resolve here; ours must reject.
test("resume that silently keeps the old model is rejected", async () => {
  const { fake } = fakeAppServer(() => "gpt-5.4-mini");
  await expect(codexSession(installation, { cwd: "/work", resume: threadId, model: "gpt-5.5" })).rejects.toThrow(
    "codex thread/resume kept model gpt-5.4-mini although gpt-5.5 was requested",
  );
  expect(fake.killed()).toBe(true);
});

test("thread/start that reports a different model is rejected too", async () => {
  fakeAppServer(() => "gpt-5.4-mini");
  await expect(codexSession(installation, { cwd: "/work", model: "gpt-5.5" })).rejects.toThrow(
    "codex thread/start kept model gpt-5.4-mini although gpt-5.5 was requested",
  );
});
