/* oxlint-disable eslint/no-continue -- Ignore malformed input and notifications in this minimal synthetic stdio MCP fixture. */
/* oxlint-disable typescript/no-unsafe-argument, typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/strict-boolean-expressions, typescript/strict-void-return, typescript/promise-function-async, typescript/prefer-nullish-coalescing, typescript/no-unnecessary-condition -- Standalone JavaScript protocol probe: preserve opaque native JSON without projecting it through OAR types. Runtime assertions below check the observed boundaries. */
import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  let r = null;
  try {
    r = JSON.parse(line);
  } catch {
    continue;
  }
  if (r.id === undefined) {
    continue;
  }
  let result = {};
  if (r.method === "initialize") {
    result = {
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "synthetic-echo", version: "1" },
    };
  } else if (r.method === "tools/list") {
    result = {
      tools: [
        {
          name: "echo",
          description: "Return a synthetic fixture marker",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        },
      ],
    };
  } else if (r.method === "tools/call") {
    result = {
      content: [
        { type: "text", text: `${process.argv[2]}:${r.params.arguments.text}` },
      ],
    };
  } else {
    result = {};
  }
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: r.id, result })}\n`,
  );
}
