/* oxlint-disable import/no-nodejs-modules, typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-argument, typescript/no-unsafe-call -- Standalone native wire fixture. */
import { createInterface } from "node:readline";

createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) { return; }
  if (request.method === process.env.FAKE_EXIT_METHOD) {
    process.stderr.write(process.env.FAKE_STDERR ?? "", () => {
      if (process.env.FAKE_EXIT_BY_SIGNAL === "1") { process.kill(process.pid, "SIGTERM"); }
      else { process.exit(1); }
    });
    return;
  }
  const reply = request.method === process.env.FAKE_ERROR_METHOD
    ? { error: JSON.parse(process.env.FAKE_ERROR) }
    : { result: request.method === "initialize"
        ? { protocolVersion: 1, agentCapabilities: process.env.FAKE_EXIT_METHOD === "session/load"
            ? { loadSession: true }
            : { sessionCapabilities: { resume: {} } } }
        : { sessionId: "saved-session", ...(process.env.FAKE_EXIT_METHOD === "session/set_config_option" ? { configOptions: [{ id: "effort", category: "thought_level", type: "select", name: "Effort", currentValue: "high", options: [] }] } : {}) } };
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, ...reply })}\n`);
});
