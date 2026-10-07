import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import type { RawEvent, Session } from "../../packages/oar/src/contracts/session.js";
import { grokRuntime } from "../../packages/oar/src/index.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { startGrokAimock } from "../harness/aimock-acp.js";
import { runtimeUnderTest } from "../harness/subject.js";
import { ECHO_SERVER, echoFixtures, echoesReceived, fingerprint } from "./support/echo-mcp.js";
import { structuralToolRound } from "./support/tool-round.js";

// Grok 1.0.46 sends the user's config.toml env in servers_updated, even
// without SessionOptions.mcpServers. The server must still receive it, but
// neither live observers nor retained/replayed records may see the value.
test.skipIf(process.env.OAR_TEST !== "grok-aimock")("grok records redact native MCP credentials without changing the server's environment", async () => {
  const secret = "oar-user-config-secret-7531";
  const env = await startGrokAimock((mock) => {
    echoFixtures(mock, /use the user server/u, [{ server: "userecho", text: "native-user" }],
      (server, text) => ({ name: "use_tool", arguments: { tool_name: `${server}__echo`, tool_input: { text } } }));
  }, [
    // Avoid Grok's one-time marketplace migration changing this fixture.
    "[marketplace]", "default_skills_installs_purged = true",
    "[mcp_servers.userecho]",
    `command = ${JSON.stringify(process.execPath)}`,
    `args = ${JSON.stringify([ECHO_SERVER])}`,
    `env = { OAR_ECHO_TOKEN = ${JSON.stringify(secret)} }`,
  ].join("\n"));
  let session: Session | undefined = undefined;
  try {
    const configFile = path.join(env.env.GROK_HOME ?? "", "config.toml");
    const config = await readFile(configFile, "utf8");
    session = await runtimeUnderTest(grokRuntime, env.env).startSession();
    const observed: RawEvent[] = [];
    session.rawEvents((record) => { observed.push(record); }, { sessionId: session.id, afterSeq: -1 });
    await structuralToolRound(session, env.mock, "please use the user server");
    const catalogs = (): unknown[] => observed.flatMap((record) => record.kind === "frame" && record.body.type === "_x.ai/mcp/servers_updated" ? [record.body.native] : []);
    await expect.poll(() => catalogs().length).toBeGreaterThan(0);
    await session.dispose();
    const replayed: RawEvent[] = [];
    session.rawEvents((record) => { replayed.push(record); }, { sessionId: session.id, afterSeq: -1 });
    expect(echoesReceived(env.raw)).toEqual([`echo:native-user via=stdio token=${fingerprint(secret)}`]);
    expect(await readFile(configFile, "utf8")).toBe(config);
    const servers = catalogs().flatMap((catalog) => {
      const entries = asRecord(catalog)?.mcpServers;
      return Array.isArray(entries) ? entries.map((entry) => asRecord(entry)) : [];
    });
    expect(servers.find((server) => server?.name === "userecho")?.env).toEqual([{ name: "OAR_ECHO_TOKEN", value: "[redacted]" }]);
    expect([session.records(), observed, replayed].map((records) => JSON.stringify(records).includes(secret))).toEqual([false, false, false]);
  } finally {
    await session?.dispose();
    await env.stop();
  }
}, 120_000);
