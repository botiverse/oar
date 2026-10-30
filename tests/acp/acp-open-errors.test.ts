import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { expect, test } from "vitest";
import { RuntimeFailureError } from "../../packages/oar/src/contracts/runtime-failure-error.js";
import { acpSession } from "../../packages/oar/src/shared/acp/session.js";
import { AcpError } from "../../packages/oar/src/shared/acp/errors.js";

const installation = { kind: "available", via: "executable", command: process.execPath } as const;
const session = acpSession({
  args: [fileURLToPath(new URL("../fixtures/fake-acp-open-error.mjs", import.meta.url))],
  capabilities: { queue: { durable: false }, attribution: "nested" },
  configureSession: async ({ request, sessionId }) => { await request("session/set_mode", { sessionId, modeId: "yolo" }); },
});
const secret = "acp-open-error-env-sentinel";

// oxlint-disable-next-line eslint/max-statements -- Exercise each opening boundary and every error surface with known and native-only secrets.
test.each(["initialize", "session/new", "session/load", "session/resume"])("ACP exit during %s includes bounded, redacted native diagnostics", async (method) => {
  const key = "sk-unprovided-native-token-1234567890";
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature";
  const environmentSecret = "acp-explicit-session-secret";
  const line = `database is locked; mcp=${secret}; env=${environmentSecret}; key=${key}; jwt=${jwt}\n`;
  const failure: unknown = await session(installation, {
    cwd: process.cwd(),
    ...(method === "session/load" || method === "session/resume" ? { resume: "saved-session" } : {}),
    mcpServers: [{ name: "echo", command: "echo", env: { TOKEN: secret } }],
    env: { FAKE_EXIT_METHOD: method, FAKE_STDERR: `old-output-to-discard${"x".repeat(9000)}\n${line}`, TEST_API_KEY: environmentSecret },
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AcpError);
  expect(failure).toMatchObject({ kind: "process_exited", exitCode: 1, cause: { exitCode: 1, signal: null } });
  expect(failure instanceof Error && failure.message).toContain("exit code 1; signal none");
  expect(failure instanceof Error && failure.message).toContain("database is locked; mcp=[redacted]; env=[redacted]; key=[redacted]; jwt=[redacted]");
  for (const output of [inspect(failure, { depth: null }), JSON.stringify(failure), failure instanceof Error ? JSON.stringify(failure.cause) : ""]) {
    for (const hidden of [secret, environmentSecret, key, jwt, "old-output-to-discard"]) { expect(output).not.toContain(hidden); }
  }
});

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
