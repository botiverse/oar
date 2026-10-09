import { inspect } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { claudeSession } from "../../packages/oar/src/runtimes/claude/session.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<() => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
const installation = { kind: "available", via: "executable", command: "claude" } as const;
const secret = "claude-open-error-env-sentinel";

afterEach(() => { spawnLineProcess.mockReset(); });

test.each(["get_settings", "initialize"])("Claude %s preserves a redacted native error response at open", async (method) => {
  const fake = fakeLineProcess((text, child) => {
    const request = asRecord(JSON.parse(text));
    child.emit(`${JSON.stringify({ type: "control_response", response: {
      request_id: request?.request_id, subtype: "error", error: `refused ${secret}`, errors: [{ detail: secret }],
    } })}\n`);
  });
  spawnLineProcess.mockReturnValue(fake);
  const failure: unknown = await claudeSession(installation, {
    cwd: process.cwd(),
    ...(method === "get_settings" ? { effort: "low" } : { serviceTier: "fast" }),
    mcpServers: [{ name: "echo", command: "echo", env: { TOKEN: secret } }],
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toMatchObject({ cause: { method, native: {
    subtype: "error", error: "refused [redacted]", errors: [{ detail: "[redacted]" }],
  } } });
  expect(inspect(failure, { depth: null })).not.toContain(secret);
  const cause = failure instanceof Error ? failure.cause : undefined;
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- JSON serialization is the boundary under test.
  expect(JSON.parse(JSON.stringify(cause))).toMatchObject({ method, native: { error: "refused [redacted]" } });
  expect(fake.killed()).toBe(true);
});

test("a successful get_settings mismatch never exposes the merged settings as an error cause", async () => {
  const fake = fakeLineProcess((text, child) => {
    const request = asRecord(JSON.parse(text));
    child.emit(`${JSON.stringify({ type: "control_response", response: {
      request_id: request?.request_id, subtype: "success", response: {
        effective: { env: { SECRET: secret } }, sources: [{ secret }], applied: { effort: "high" },
      },
    } })}\n`);
  });
  spawnLineProcess.mockReturnValue(fake);
  const failure: unknown = await claudeSession(installation, { cwd: process.cwd(), effort: "low" }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toHaveProperty("cause");
  expect(inspect(failure, { depth: null })).not.toContain(secret);
  expect(fake.killed()).toBe(true);
});
