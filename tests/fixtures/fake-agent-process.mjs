/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument -- Standalone untyped child-process fixture. */
import { createInterface } from "node:readline";
// oxlint-disable-next-line import/no-unassigned-import -- run for its side effect: the env-switched process tree
import "./agent-tree.mjs";

/*
 * A stand-in agent binary for process-lifecycle tests. It grows the
 * env-switched process tree (agent-tree.mjs) and speaks just enough codex
 * app-server JSON-RPC and Qwen SDK control to open a session; other stdin lines are ignored,
 * which is all the claude adapter needs to open a session.
 */
const results = new Map([
  ["initialize", {}],
  ["thread/start", { thread: { id: "fake-thread" } }],
]);
createInterface({ input: process.stdin }).on("line", (line) => {
  let message = null;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (process.argv.includes("--channel=SDK") === true && message?.request?.subtype === "initialize") {
    const sessionId = process.argv[process.argv.indexOf("--session-id") + 1];
    process.stdout.write(`${JSON.stringify({ type: "control_response", response: {
      subtype: "success", request_id: message.request_id, response: { session_id: sessionId },
    } })}\n`);
  }
  const result = results.get(message?.method);
  if (result !== undefined && message.id !== undefined) {
    process.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
  }
});
