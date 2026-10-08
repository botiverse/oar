/** Runnable session-scoped Parallel Search MCP example. See docs/examples/parallel-search.md. */
import { pathToFileURL } from "node:url";
import { defaultRuntimes, promptAndWait, type McpServer } from "../packages/oar/src/index.js";

export const parallelSearchMcp = {
  name: "parallel",
  type: "http",
  url: "https://search.parallel.ai/mcp",
  headers: { "User-Agent": "oar-parallel-search-example/1.0 (https://github.com/botiverse/oar)" },
} satisfies McpServer;

async function main(): Promise<void> {
  const prompt = process.argv.slice(2).join(" ").trim();
  if (prompt.length === 0) {
    throw new Error('Usage: pnpm tsx experiments/parallel-search.ts "<research question>"');
  }
  const runtime = defaultRuntimes.require("claude");
  const installation = await runtime.installation?.();
  if (installation?.kind !== "available") {
    throw new Error("Install and sign in to Claude Code before running this example.");
  }
  const session = await runtime.session(installation, {
    cwd: process.cwd(),
    mcpServers: [parallelSearchMcp],
    appendSystemPrompt: "Use the Parallel web_search tool for research. Cite source URLs. Use web_fetch only when search excerpts are insufficient or the user asks about a specific URL. Reuse one session_id across related Parallel calls.",
  });
  try {
    session.events((event) => {
      if (event.kind === "text_delta" && event.agentPath.length === 0) {
        process.stdout.write(event.text);
      }
      if (event.kind === "tool_call_started") {
        process.stderr.write(`Tool: ${event.tool}\n`);
      }
    });
    const outcome = await promptAndWait(session, prompt, { timeoutMs: 180_000 });
    if (outcome.kind !== "ended" || outcome.outcome.kind !== "completed") {
      throw new Error(`Research turn did not complete: ${JSON.stringify(outcome)}`);
    }
    process.stdout.write("\n");
  } finally {
    await session.dispose();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
