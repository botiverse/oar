import { expect, test } from "vitest";
import type { RawEvent, Session } from "../../packages/oar/src/contracts/session.js";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import { redactGrokNotification } from "../../packages/oar/src/shared/credential-redaction.js";
import { grokAcpProfile } from "../../packages/oar/src/runtimes/grok/session.js";
import { fixture, start } from "../fixtures/acp-session-support.js";

test.each(["_x.ai/mcp/servers_updated", "_x.ai/mcp/server_status", "_x.ai/mcp/init_progress", "_x.ai/mcp_initialized"])("%s only redacts credential values, preserving the received object", (method) => {
  const native = {
    sessionId: "session-1", name: "remote", status: "ready", connected: 2,
    env: { API_KEY: "env-secret", PATH: "/bin" },
    headers: [{ name: "Authorization", value: "header-secret", source: "user" }],
    bearerToken: "bearer-secret", bearer_token_env_var: "TOKEN_NAME",
    tools: [{ name: "sample", inputSchema: { properties: { input: { type: "string" } } } }],
  };
  const before = structuredClone(native);
  expect(redactGrokNotification(method, native)).toEqual({
    sessionId: "session-1", name: "remote", status: "ready", connected: 2,
    env: { API_KEY: "[redacted]", PATH: "[redacted]" },
    headers: [{ name: "Authorization", value: "[redacted]", source: "user" }],
    bearerToken: "[redacted]", bearer_token_env_var: "TOKEN_NAME",
    tools: [{ name: "sample", inputSchema: { properties: { input: { type: "string" } } } }],
  });
  expect(native).toEqual(before);
});

test("MCP credentials are redacted under arbitrary containers and nesting", () => {
  const native = { update: { servers: [{ config: {
    env: [{ name: "API_KEY", value: "nested-env-secret", source: "user" }],
    transport: { headers: { Authorization: "nested-header-secret" }, http_headers: [{ name: "X-Key", value: "nested-http-secret" }] },
    auth: [{ bearer_token: "nested-bearer-secret" }, { bearerToken: "nested-camel-secret" }],
    command: "echo", args: ["hello"], enabled: true,
  } }] }, revision: 1 };
  const before = structuredClone(native);
  const redacted = redactGrokNotification("_x.ai/mcp/servers_updated", native);
  expect(redacted).toEqual({ update: { servers: [{ config: {
    env: [{ name: "API_KEY", value: "[redacted]", source: "user" }],
    transport: { headers: { Authorization: "[redacted]" }, http_headers: [{ name: "X-Key", value: "[redacted]" }] },
    auth: [{ bearer_token: "[redacted]" }, { bearerToken: "[redacted]" }],
    command: "echo", args: ["hello"], enabled: true,
  } }] }, revision: 1 });
  expect(JSON.stringify(redacted)).not.toContain("nested-");
  expect(native).toEqual(before);
});

test("other vendor notifications and credential-free MCP payloads stay intact", () => {
  const native = { sessionId: "s", update: { env: { EXAMPLE: "not a configuration" } } };
  expect(redactGrokNotification("_x.ai/session_notification", native)).toBe(native);
  expect(redactGrokNotification("_x.ai/mcp/server_status", { sessionId: "s", status: "ready", detail: "connected", tools: null })).toEqual({ sessionId: "s", status: "ready", detail: "connected", tools: null });
  expect(redactGrokNotification("_x.ai/mcp/servers_updated", { mcpServers: [{ name: "remote", headers: { Authorization: "secret" }, env: [], bearer_token: null }] })).toEqual({ mcpServers: [{ name: "remote", headers: { Authorization: "[redacted]" }, env: [], bearer_token: null }] });
});

function observe(session: Session): RawEvent[] {
  const records: RawEvent[] = [];
  session.rawEvents((record) => { records.push(record); }, { sessionId: session.id, afterSeq: -1 });
  return records;
}

function expectStreamsRedacted(session: Session, observed: readonly RawEvent[]): void {
  const replayed = observe(session);
  expect(observed).toEqual(session.records());
  expect(replayed).toEqual(session.records());
  const streams = [session.records(), observed, replayed].map((records) => JSON.stringify(records));
  for (const secret of ["fixture-env-secret", "fixture-header-secret", "fixture-bearer-secret"]) {
    expect(streams.map((stream) => stream.includes(secret)), secret).toEqual([false, false, false]);
  }
}

test("credentials never enter queued startup records, live observations or replay", async () => {
  const session = await start({ ...grokAcpProfile, args: [fixture, "grok-credentials"] });
  try {
    const observed = observe(session);
    await promptAndWait(session, "hello");
    await session.dispose();

    const native = session.records().flatMap((record) => record.kind === "frame" && record.body.type === "_x.ai/mcp/servers_updated" ? [record.body.native] : []);
    expect(native).toEqual(["opening", "live"].map((phase) => ({ phase, mcpServers: [
      { name: "local", source: "local", type: "stdio", command: "echo", args: [], env: [{ name: "API_KEY", value: "[redacted]" }] },
      { name: "remote", type: "http", url: "https://example.test/mcp", headers: [{ name: "Authorization", value: "[redacted]" }], bearer_token: "[redacted]" },
    ] })));
    expectStreamsRedacted(session, observed);
  } finally {
    await session.dispose();
  }
});
