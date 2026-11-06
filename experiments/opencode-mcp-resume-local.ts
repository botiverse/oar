/* oxlint-disable eslint/no-await-in-loop -- Each cold process resumes the session produced by its predecessor. */
/**
 * Local-provider control for OpenCode issue 54794; no login or remote model.
 * OAR_OPENCODE_BIN=/path/to/opencode pnpm tsx experiments/opencode-mcp-resume-local.ts <output.json> [cold-resumes=3]
 * The first session has one seed turn; resumed processes call the tool immediately.
 * Raw sidecars include local paths and are not intended for publication.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { opencodeRuntime, promptAndWait } from "../packages/oar/src/index.js";
import type { McpServer } from "../packages/oar/src/contracts/session.js";
import { startOpencodeAimock } from "../sea-trial/harness/aimock-acp.js";
import { echoesReceived, startHttpEcho, stdioEcho } from "../sea-trial/vendor/support/echo-mcp.js";

const [output, countText = "3"] = process.argv.slice(2);
const count = Number(countText);
assert.ok(Number.isInteger(count) && count >= 0);
assert.ok(output !== undefined, "usage: OAR_OPENCODE_BIN=<binary> tsx opencode-mcp-resume-local.ts <output.json> [cold-resumes=3]");
const installation = await opencodeRuntime.installation();
assert.ok(installation.kind === "available" && installation.via === "executable");
const selectedInstallation = installation;
const outputFile = output;
const results: unknown[] = [];
async function inspectTransport(transport: "stdio" | "http"): Promise<void> {
  const http = await startHttpEcho();
  const stages = new Map<string, number>();
  const requests: { marker: string; tools: string[]; catalogNotices: string[] }[] = [];
  const fixture = await startOpencodeAimock((mock) => {
    mock.onMessage(/LOCAL_MCP_.*_seed/u, { content: "seed complete" }, { streamingProfile: { ttft: 250 } });
    mock.on({ predicate: () => true }, (request) => {
      const latestUser = request.messages.findLast((message) => message.role === "user" && JSON.stringify(message.content).includes("LOCAL_MCP_"));
      const marker = /LOCAL_MCP_(?:stdio|http)_\d+/u.exec(JSON.stringify(latestUser))?.[0];
      assert.ok(marker !== undefined, "provider request must belong to a controlled prompt");
      const stage = stages.get(marker) ?? 0;
      stages.set(marker, stage + 1);
      if (stage > 0) { return { content: "local tool round complete" }; }
      requests.push({ marker, tools: request.tools?.map((tool) => tool.function.name) ?? [],
        catalogNotices: request.messages.map((message) => JSON.stringify(message.content)).filter((content) => content.includes("Code Mode tool catalog")),
      });
      return { toolCalls: [{ id: `call-${marker}`, name: "execute", arguments: JSON.stringify({ code: `return await tools.echo.echo(${JSON.stringify({ text: marker })});` }) }] };
    });
  });
  try {
    const mcpServers: readonly McpServer[] = [transport === "stdio" ? stdioEcho("echo") : { name: "echo", type: "http", url: http.url }];
    let sessionId: string | null = null;
    for (let round = 0; round <= count; round++) {
      const marker = `LOCAL_MCP_${transport}_${String(round)}`;
      const session = await opencodeRuntime.session(selectedInstallation, {
        cwd: fixture.env.HOME ?? "", env: fixture.env, model: "aimock/aimock-model", mcpServers,
        ...(sessionId === null ? {} : { resume: sessionId }),
      });
      sessionId = session.id;
      try {
        if (round === 0) {
          const seed = await promptAndWait(session, `LOCAL_MCP_${transport}_seed`, { timeoutMs: 30_000 });
          assert.equal(seed.kind, "ended");
          assert.equal(seed.outcome.kind, "completed");
        }
        const outcome = await promptAndWait(session, marker, { timeoutMs: 30_000 });
        const echoReceived = echoesReceived(fixture.raw).includes(`echo:${marker} via=${transport} token=none`);
        const request = requests.find((value) => value.marker === marker);
        assert.ok(request !== undefined);
        const lastNotice = request.catalogNotices.at(-1) ?? null;
        const observation = { transport, round, resumed: round > 0, outcome: outcome.kind === "ended" ? outcome.outcome.kind : outcome.kind, echoReceived,
          tools: request.tools, catalogNoticeCount: request.catalogNotices.length,
          lastNoticeMentionsEcho: lastNotice?.includes("echo") ?? false,
          lastNoticeSaysRemoved: lastNotice?.includes("no longer available") ?? false,
        };
        results.push(observation);
        console.log(JSON.stringify(observation));
        await writeFile(outputFile, `${JSON.stringify({ version: selectedInstallation.version, provider: "local scripted", results }, null, 2)}\n`);
        if (outcome.kind !== "ended" || outcome.outcome.kind !== "completed" || !echoReceived) { process.exitCode = 1; }
      } finally { await session.dispose(); }
    }
  } finally {
    await writeFile(`${outputFile}.${transport}.raw.json`, `${JSON.stringify(fixture.raw, null, 2)}\n`);
    await fixture.stop(); http.stop();
  }
}

for (const transport of ["stdio", "http"] as const) { await inspectTransport(transport); }
