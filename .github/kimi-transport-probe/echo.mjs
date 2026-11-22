import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
  const q = JSON.parse(line);
  if (q.id == null) continue;
  const result =
    q.method === "initialize"
      ? {
          protocolVersion: q.params.protocolVersion,
          serverInfo: { name: "fixture", version: "1" },
          capabilities: { tools: {} },
        }
      : q.method === "tools/list"
        ? {
            tools: [
              {
                name: "echo",
                description: "Local fixture",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          }
        : q.method === "tools/call"
          ? { content: [{ type: "text", text: "fixture" }] }
          : {};
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id: q.id, result }) + "\n",
  );
}
