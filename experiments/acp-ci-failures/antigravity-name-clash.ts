/** Local-provider reproduction of the unchanged ACP MCP name-clash fixture. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { antigravityInstallation, antigravitySession, defineRuntime } from "../../packages/oar/src/index.js";
import { startAntigravityAimock } from "../../sea-trial/harness/aimock-acp.js";
import { runtimeUnderTest } from "../../sea-trial/harness/subject.js";
import { resolveRunDir } from "../../sea-trial/harness/trace.js";
import { currentTurnSays, ECHO_SERVER, echoesReceived, echoFixtures, scriptEchoes, stdioEcho, type EchoCall } from "../../sea-trial/vendor/support/echo-mcp.js";
import { structuralToolRound } from "../../sea-trial/vendor/support/tool-round.js";

const call: EchoCall = (server, text) => server === "userecho"
  ? { name: "call_mcp_tool", arguments: { ServerName: server, ToolName: "echo", Arguments: { text } } }
  : { name: `mcp_${server}_echo`, arguments: { text, toolSummary: "Echo the text" } };
const userServer = { command: process.execPath, args: [ECHO_SERVER], env: { OAR_ECHO_TOKEN: "oar-user-credential" } };
const runtime = defineRuntime({ id: "antigravity-aimock", session: antigravitySession, installation: antigravityInstallation });
const output = resolveRunDir();

async function probe(iteration: number): Promise<void> {
  const env = await startAntigravityAimock(mock => {
    scriptEchoes(mock, call);
    echoFixtures(mock, /call echo over the user's own/u, [{ server: "echo", text: "clash-own" }, { server: "userecho", text: "clash-user" }], call);
    mock.on({ predicate: currentTurnSays(/just answer/u) }, { content: "answered" });
  }, { mcpServers: { echo: userServer, userecho: userServer } });
  try {
    const session = await runtimeUnderTest(runtime, env.env).startSession({ mcpServers: [stdioEcho("echo")] });
    try {
      await structuralToolRound(session, env.mock, "please call echo over the user's own");
      assert.deepEqual(echoesReceived(env.raw).map(text => text.split(" via=")[0]), ["echo:clash-own", "echo:clash-user"]);
    } finally {
      await session.dispose();
      await writeFile(path.join(output, `clash-${String(iteration)}.json`), JSON.stringify({
        echoes: echoesReceived(env.raw), raw: env.raw, journal: env.mock.journal.getAll(), records: session.records(),
      }, null, 2));
    }
    process.stdout.write(`${JSON.stringify({ iteration, echoes: 2, requests: env.raw.length })}\n`);
  } finally { await env.stop(); }
}

const rounds = Number(process.argv[2] ?? 1);
assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 10, "Choose 1 to 10 rounds");
for (let iteration = 0; iteration < rounds; iteration++) {
  // oxlint-disable-next-line no-await-in-loop -- Each control owns a fresh HOME and ends before the next starts.
  await probe(iteration);
}
