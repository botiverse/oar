import { inspect } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { SessionNotFoundError } from "../../packages/oar/src/index.js";
import { codexSession } from "../../packages/oar/src/runtimes/codex/session.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";
import errors from "../fixtures/missing-resume-errors.json" with { type: "json" };

const spawnLineProcess = vi.hoisted(() => vi.fn<() => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
const installation = { kind: "available", via: "executable", command: "codex" } as const;
afterEach(() => { spawnLineProcess.mockReset(); });
function fault(native: object, method = "thread/resume") {
  const fake = fakeLineProcess((text, child) => {
    const request = asRecord(JSON.parse(text));
    if (typeof request?.id !== "number") { return; }
    child.emit(`${JSON.stringify({ id: request.id, ...(request.method === method ? { error: native } : { result: {} }) })}\n`);
  });
  spawnLineProcess.mockReturnValue(fake);
  return fake;
}

test("Codex's recorded missing rollout failure is typed, retaining native cause and redaction", async () => {
  const secret = "00000000-0000-4000-8000-000000000294";
  const native = errors.codex;
  const fake = fault(native);
  const failure: unknown = await codexSession(installation, { cwd: process.cwd(), resume: secret, serviceTier: "flex", env: { API_KEY: secret } }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(SessionNotFoundError);
  expect(failure).toMatchObject({ sessionId: "[redacted]", cause: { method: "thread/resume", native: { code: -32_600, message: "no rollout found for thread id [redacted]" } } });
  expect(inspect(failure, { depth: null })).not.toContain(secret);
  expect(fake.killed()).toBe(true);
});

test.each([
  { ...errors.codex, message: "thread existing already has an active writer" },
  { ...errors.codex, message: "cannot resume an unloaded multi-agent v2 sub-agent through its parent; resume the sub-agent directly" },
  { ...errors.codex, message: "other error: no rollout found for thread id missing" },
  { ...errors.codex, code: -32_603 },
])("another Codex refusal stays unchanged: $message", async (native) => {
  const fake = fault(native);
  const failure: unknown = await codexSession(installation, { cwd: process.cwd(), resume: "existing" }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(SessionNotFoundError);
  expect(failure).toMatchObject({ cause: { method: "thread/resume", native } });
  expect(fake.killed()).toBe(true);
});

test.each(["initialize", "thread/start"])("Codex only maps the error on thread/resume, not %s", async (method) => {
  const fake = fault(errors.codex, method);
  const failure: unknown = await codexSession(installation, { cwd: process.cwd() }).catch((error: unknown) => error);
  expect(failure).not.toBeInstanceOf(SessionNotFoundError);
  expect(failure).toMatchObject({ cause: { method, native: errors.codex } });
  fake.kill();
});
