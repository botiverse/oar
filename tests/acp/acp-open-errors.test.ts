import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { expect, test } from "vitest";
import { RuntimeFailureError } from "../../packages/oar/src/contracts/runtime-failure-error.js";
import { acpSession } from "../../packages/oar/src/shared/acp/session.js";

const installation = { kind: "available", via: "executable", command: process.execPath } as const;
const session = acpSession({
  args: [fileURLToPath(new URL("../fixtures/fake-acp-open-error.mjs", import.meta.url))],
  capabilities: { queue: { durable: false }, attribution: "nested" },
  configureSession: async ({ request, sessionId }) => { await request("session/set_mode", { sessionId, modeId: "yolo" }); },
});
const secret = "acp-open-error-env-sentinel";

// oxlint-disable-next-line eslint/max-statements -- One open, its classification, cause and all diagnostic surfaces.
test.each(["initialize", "session/new", "session/resume", "session/set_mode"])("ACP %s keeps code/data and method while redacting the entire cause chain", async (method) => {
  const failure: unknown = await session(installation, {
    cwd: process.cwd(),
    ...(method === "session/resume" ? { resume: "saved-session" } : {}),
    mcpServers: [{ name: "echo", command: "echo", env: { TOKEN: secret } }],
    env: { FAKE_ERROR_METHOD: method, FAKE_ERROR: JSON.stringify({ code: -32_000, message: `denied ${secret}`, data: { nested: [{ [secret]: secret }], status: 401 } }) },
  }).catch((error: unknown) => error);
  const mapped = method !== "session/set_mode";
  expect(failure).toBeInstanceOf(mapped ? RuntimeFailureError : Error);
  if (mapped) { expect(failure).toMatchObject({ failure: "auth" }); }
  const nativeCause = failure instanceof Error ? failure.cause : undefined;
  expect(nativeCause).toEqual({
    method,
    native: { code: -32_000, message: "denied [redacted]", data: { nested: [{ "[redacted]": "[redacted]" }], status: 401 } },
  });
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- JSON serialization is the boundary under test.
  expect(JSON.parse(JSON.stringify(nativeCause))).toMatchObject({ method, native: { message: "denied [redacted]" } });
  for (const output of [inspect(failure, { depth: null }), JSON.stringify(failure), JSON.stringify(nativeCause)]) {
    expect(output).not.toContain(secret);
  }
});
