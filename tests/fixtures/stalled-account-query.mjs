/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument, typescript/no-unsafe-return, typescript/strict-boolean-expressions -- Untyped standalone native-protocol fixture. */
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const stage = process.env.OAR_QUERY_STAGE;
if (process.argv.includes("--help") && stage !== "help") {
  process.stdout.write("--safe-mode\n");
  process.exit(0);
}
// Only the deliberately stalled process grows a tree. A successful help
// preflight must not overwrite its PID evidence or start unrelated children.
await import("./agent-tree.mjs");
const record = (method) => appendFileSync(process.env.OAR_QUERY_REQUESTS, `${method}\n`);
record(process.argv.includes("--help") ? "help" : "started");
// oxlint-disable-next-line max-statements -- Minimal replies for both control-JSON and ACP in one standalone fixture.
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  const method = message.method ?? message.request?.subtype;
  record(method);
  if (method === stage || message.id === undefined && message.request_id === undefined) { return; }
  if (message.type === "control_request") {
    process.stdout.write(`${JSON.stringify({ type: "control_response", response: {
      subtype: "success", request_id: message.request_id, response: {},
    } })}\n`);
    return;
  }
  let result = {};
  if (method === "initialize") { result = { protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: "login", name: "Login" }] }; }
  if (method === "_x.ai/billing") { result = { config: { creditUsagePercent: 25 } }; }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
});
