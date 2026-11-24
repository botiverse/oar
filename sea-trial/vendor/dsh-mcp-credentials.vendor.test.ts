import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { serveMcpTools } from "../../packages/oar/src/index.js";
import { runTurn } from "./support/asserts.js";
import { dshEnabled, withDshFixture } from "./support/dsh-fixture.js";
import { fingerprint, stdioEcho } from "./support/echo-mcp.js";

test.skipIf(!dshEnabled)("the first turn can call a credentialed stdio tool and a served host tool", async () => {
  const token = randomUUID();
  const served = await serveMcpTools({ name: "managed", tools: [{
    name: "check", inputSchema: { type: "object", properties: {} }, handler: () => "host tool receipt",
  }] });
  const stdioResult = `echo:check via=stdio token=${fingerprint(token)}`;
  try {
    await withDshFixture(request => {
      const results = request.messages.filter(message => message.role === "tool");
      if (results.length >= 2) { return { kind: "say", text: "done" }; }
      if (results.length === 1) { return { kind: "tool", name: "mcp__managed__check", arguments: {} }; }
      return { kind: "tool", name: "mcp__local__echo", arguments: { text: "check" } };
    }, async ({ open, provider }) => {
      const session = await open({ mcpServers: [stdioEcho("local", token), served.server] });
      expect(await runTurn(session, "Check both MCP tools")).toEqual({ kind: "completed" });
      const last = JSON.stringify(provider.requests.at(-1)?.messages);
      expect(last).toContain(stdioResult);
      expect(last).toContain("host tool receipt");
      const stored = JSON.stringify(session.records());
      expect(stored).not.toContain(token);
      expect(stored).not.toContain(served.server.headers?.Authorization?.slice("Bearer ".length));
    });
  } finally { await served.close(); }
}, 60_000);
