import { inspect } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { codexSession } from "../../packages/oar/src/runtimes/codex/session.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<() => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
const installation = { kind: "available", via: "executable", command: "codex" } as const;
const secret = "open-error-env-sentinel";
const header = "Bearer open-error-header-sentinel";

afterEach(() => { spawnLineProcess.mockReset(); });

// oxlint-disable-next-line eslint/max-statements -- One open, its cause round-trip, and every host-visible diagnostic surface.
test.each(["initialize", "thread/start", "thread/resume"])("%s failure keeps its redacted native error before a Session exists", async (method) => {
  const fake = fakeLineProcess((text, child) => {
    const request = asRecord(JSON.parse(text));
    if (typeof request?.id !== "number") { return; }
    const reply = request.method === method
      ? { error: { code: -32_603, message: `refused ${secret}`, data: { detail: [header, { [secret]: secret }], retryable: false } } }
      : { result: {} };
    child.emit(`${JSON.stringify({ id: request.id, ...reply })}\n`);
  });
  spawnLineProcess.mockReturnValue(fake);
  try {
    const failure: unknown = await codexSession(installation, {
      cwd: process.cwd(),
      ...(method === "thread/resume" ? { resume: "saved-thread" } : {}),
      mcpServers: [
        { name: "echo", command: "echo", env: { TOKEN: secret } },
        { name: "remote", type: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: header } },
      ],
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const nativeCause = failure instanceof Error ? failure.cause : undefined;
    expect(nativeCause).toEqual({
      method,
      native: { code: -32_603, message: "refused [redacted]", data: { detail: ["[redacted]", { "[redacted]": "[redacted]" }], retryable: false } },
    });
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- JSON serialization is the boundary under test.
    expect(JSON.parse(JSON.stringify(nativeCause))).toEqual(nativeCause);
    for (const output of [inspect(failure, { depth: null }), JSON.stringify(failure), JSON.stringify(nativeCause)]) {
      expect(output).not.toContain(secret);
      expect(output).not.toContain(header);
    }
    expect(fake.killed()).toBe(true);
  } finally { fake.kill(); }
});
