import { inspect } from "node:util";
import { expect, test } from "vitest";
import { mcpCredentialRedactor } from "../packages/oar/src/shared/mcp-servers.js";
import { sessionCredentialRedactor } from "../packages/oar/src/shared/credential-redactor.js";
import { withSessionCredentials } from "../packages/oar/src/shared/session-credentials.js";
import { createSessionKernel } from "../packages/oar/src/shared/session-kernel.js";
import { RuntimeFailureError } from "../packages/oar/src/contracts/runtime-failure-error.js";
import type { RawEvent } from "../packages/oar/src/contracts/session.js";

const secret = "sentinel-provider-secret";

test.each(["KEY", "APIKEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "PASSPHRASE", "CREDENTIAL", "CREDENTIALS", "COOKIE", "PWD", "ANTHROPIC_API_KEY", "AWS_SECRET_ACCESS_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "GITHUB_TOKEN", "MYSQL_PWD", "PGPASSWORD", "custom_apikey"])("redacts explicit credential %s", (name) => {
  const { redact } = sessionCredentialRedactor({ cwd: "/work", env: { [name]: secret } });
  expect(redact(`rejected ${secret}`)).toBe("rejected [redacted]");
});

test.each([
  ["SSH_AUTH_SOCK", "/run/user/1000/ssh-agent"], ["XAUTHORITY", "/home/user/.Xauthority"],
  ["GIT_AUTHOR_EMAIL", "author@example.test"], ["GIT_AUTHOR_NAME", "Example Author"],
  ["PASSWORD_STORE_DIR", "/home/user/.password-store"], ["GNUPG_PASSPHRASE_FILE", "/home/user/passphrase"],
  ["KEYTIMEOUT", "12345678"], ["AWS_ACCESS_KEY_ID", "public-access-id"],
  ["PATH", "/usr/local/bin:/usr/bin"], ["HOME", "/home/user"], ["PWD", "/workspace/project"], ["OLDPWD", "/workspace/previous"],
  ["API_KEY", "/etc/credentials/key"], ["AUTH_TOKEN", "~/credentials/token"], ["SECRET", String.raw`C:\credentials\key`],
  ["API_KEY", "short"], ["TOKEN", ""], ["TOKEN", null],
])("preserves noncredential or path %s=%s", (name, value) => {
  const { redact } = sessionCredentialRedactor({ cwd: "/work", env: { [name]: value } });
  const text = `diagnostic: ${String(value)}`;
  expect(redact(text)).toBe(text);
});

test("uses longest-first across env, MCP and SDK keys, and retains previous keys after a model change", () => {
  const { redact, add } = sessionCredentialRedactor({ cwd: "/work", env: { API_KEY: `${secret}-long` }, mcpServers: [{ name: "echo", command: "echo", env: { TOKEN: secret } }] });
  add(`${secret}-longer`);
  expect(redact(`${secret}-longer ${secret}-long ${secret}`)).toBe("[redacted] [redacted] [redacted]");
});

// oxlint-disable-next-line eslint/max-statements -- One stream, checked across control, live delivery and replay.
test("redacts before retention and delivery, while control receives original input and native data is unchanged", async () => {
  const { redactValue } = sessionCredentialRedactor({ cwd: "/work", env: { API_KEY: secret } });
  const kernel = createSessionKernel("session", redactValue);
  const live: RawEvent[] = [];
  kernel.rawEvents((record) => { live.push(record); });
  const result = await kernel.control({ kind: "prompt", input: secret }, (request) => {
    expect(request.body).toEqual({ kind: "prompt", input: secret });
    return { kind: "rejected", code: "error", reason: secret };
  });
  const native = { [secret]: { secret, path: "/workspace/safe-path" } };
  kernel.frame({ type: "native/error", native, events: [{ kind: "turn_ended", outcome: { kind: "failed", failure: "provider", reason: secret } }] });
  const replay: RawEvent[] = [];
  kernel.rawEvents((record) => { replay.push(record); }, { sessionId: "session", afterSeq: -1 });
  expect(live).toEqual(replay);
  expect(live).toEqual(kernel.records());
  for (const value of [result, live, replay, kernel.records()]) {
    expect(JSON.stringify(value)).not.toContain(secret);
    expect(inspect(value, { depth: null })).not.toContain(secret);
  }
  expect(JSON.stringify(live)).toContain("/workspace/safe-path");
  expect(native[secret].secret).toBe(secret);
});

test("opening failures redact frozen native Error fields and cause data while preserving their class", async () => {
  const native: RuntimeFailureError = Object.freeze(new RuntimeFailureError("auth", secret, { cause: { message: secret, nested: [secret] } }));
  const open = withSessionCredentials(async () => { throw native; });
  const failure: unknown = await open({ kind: "available", via: "bundled" }, { cwd: "/work", env: { API_KEY: secret } }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(RuntimeFailureError);
  expect(failure).toMatchObject({ failure: "auth", reason: "[redacted]", cause: { message: "[redacted]", nested: ["[redacted]"] } });
  expect(failure instanceof Error ? failure.stack : undefined).toContain("[redacted]");
  expect(inspect(failure, { depth: null })).not.toContain(secret);
  expect(JSON.stringify(failure)).not.toContain(secret);
  expect(native.message).toBe(secret);
});

test("errors from later session methods use the same redactor", async () => {
  const open = withSessionCredentials(async (_installation, _options, credentials) => {
    const kernel = credentials.kernel("session");
    return credentials.seal({
      id: kernel.sessionId,
      capabilities: { queue: { durable: false }, attribution: "attributed", images: false },
      prompt: async () => { throw new Error(secret, { cause: { detail: secret } }); },
      // oxlint-disable-next-line typescript/only-throw-error -- Native APIs can throw a string; exercise that error boundary too.
      queue: async () => { throw secret; },
      abort: async () => kernel.control({ kind: "abort" }, () => ({ kind: "accepted" })),
      dispose: async () => { throw new Error(secret); },
      rawEvents: (observer, cursor) => kernel.rawEvents(observer, cursor),
      records: () => kernel.records(),
      graph: () => kernel.graph(),
    });
  });
  const session = await open({ kind: "available", via: "bundled" }, { cwd: "/work", env: { API_KEY: secret } });
  await expect(session.prompt("hello")).rejects.toMatchObject({ message: "[redacted]", cause: { detail: "[redacted]" } });
  await expect(session.queue("hello")).rejects.toBe("[redacted]");
  await expect(session.dispose()).rejects.toThrow("[redacted]");
});


test.each([{}, { API_KEY: secret }])("retains unmatched frame objects without copying (env %j)", (env) => {
  const { redactValue } = sessionCredentialRedactor({ cwd: "/work", env });
  const kernel = createSessionKernel("session", redactValue);
  const body = { type: "tool/output", native: { output: "ordinary output", nested: ["unchanged"] }, events: [] };
  const frame = kernel.frame(body);
  expect(frame.body).toBe(body);
  expect(kernel.records()[0]).toBe(frame);
  expect(redactValue(frame)).toBe(frame);
});

test("a key learned after opening enables redaction for subsequent records", () => {
  const { redactValue, add } = sessionCredentialRedactor({ cwd: "/work" });
  const kernel = createSessionKernel("session", redactValue);
  const body = { type: "native/error", native: { message: secret }, events: [] };
  expect(kernel.frame(body).body).toBe(body);
  add(secret);
  expect(kernel.frame(body).body.native).toEqual({ message: "[redacted]" });
  expect(body.native.message).toBe(secret);
});


test.each(["ollama", "EMPTY", "none", "x", "/path/to/credential", "~/credential", String.raw`C:\credentials\key`])("ignores short or path-shaped SDK key %s", (key) => {
  const { add, redactValue } = sessionCredentialRedactor({ cwd: "/work" });
  add(key);
  const native = { model: `${key}/model`, text: `provider ${key}` };
  expect(redactValue(native)).toBe(native);
});


test("MCP ordinary env and headers remain unchanged in records and error text", () => {
  const servers = [
    { name: "local", command: "echo", env: { DEBUG: "true", LOG_LEVEL: "debug", NODE_ENV: "production", TOKEN: "short", SECRET: "/path/to/secret" } },
    { name: "remote", type: "http" as const, url: "http://localhost", headers: { "Content-Type": "application/json" } },
  ];
  const { redactValue } = sessionCredentialRedactor({ cwd: "/work", mcpServers: servers });
  const kernel = createSessionKernel("session", redactValue);
  const body = { type: "tool/output", native: { text: "debug is true in production, application/json, short, /path/to/secret" }, events: [] };
  expect(kernel.frame(body).body).toBe(body);
  expect(mcpCredentialRedactor(servers)(body.native.text)).toBe(body.native.text);
});

test.each(["Authorization", "Proxy-Authorization", "Cookie", "X-Api-Key", "Api-Key", "X-Service-Token", "x-custom-secret"])("MCP credential header %s uses shared record and error redaction", (name) => {
  const servers = [{ name: "remote", type: "http" as const, url: "http://localhost", headers: { [name]: secret } }];
  const { redactValue } = sessionCredentialRedactor({ mcpServers: servers });
  expect(redactValue({ text: secret })).toEqual({ text: "[redacted]" });
  expect(mcpCredentialRedactor(servers)(secret)).toBe("[redacted]");
});

test.each(["Bearer", "Basic", "Token"])("MCP Authorization %s protects its complete value and bare credential", (scheme) => {
  const value = `${scheme} ${secret}`;
  const servers = [{ name: "remote", type: "http" as const, url: "http://localhost", headers: { Authorization: value } }];
  const { redactValue } = sessionCredentialRedactor({ mcpServers: servers });
  const native = { full: value, bare: secret, ordinary: "application/json" };
  expect(redactValue(native)).toEqual({ full: "[redacted]", bare: "[redacted]", ordinary: "application/json" });
  expect(mcpCredentialRedactor(servers)(`${value}; ${secret}`)).toBe("[redacted]; [redacted]");
});


test.each([false, true])("env connection strings protect full URLs and encoded/decoded passwords (MCP=%s)", (mcp) => {
  const encoded = "oar%3Along-password%2Ffor-db";
  const decoded = "oar:long-password/for-db";
  const env = { DATABASE_URL: `postgres://user:${encoded}@localhost/db`, MONGODB_URI: `mongodb+srv://user:${secret}@localhost/db`, REDIS_URL: `redis://:${secret}@localhost:6379`, PUBLIC_URL: "http://localhost:3000" };
  const options = mcp ? { mcpServers: [{ name: "db", command: "echo", env }] } : { env };
  const { redactValue } = sessionCredentialRedactor(options);
  expect(redactValue({ urls: Object.values(env), encoded, decoded, password: secret })).toEqual({ urls: ["[redacted]", "[redacted]", "[redacted]", "http://localhost:3000"], encoded: "[redacted]", decoded: "[redacted]", password: "[redacted]" });
});

test("connection URLs with short passwords redact only the whole URL", () => {
  const url = "postgres://user:pass@localhost/db";
  const { redact } = sessionCredentialRedactor({ env: { DATABASE_URL: url } });
  expect(redact(`${url}; tests pass`)).toBe("[redacted]; tests pass");
});
