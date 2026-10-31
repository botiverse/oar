/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument, typescript/no-unsafe-return, typescript/promise-function-async, promise/avoid-new, promise/prefer-await-to-callbacks -- Standalone ACP process fixture with real independently grouped descendants. */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import readline from "node:readline";

const role = process.argv[2] ?? "root";
const start = childRole => new Promise(resolve => {
  const child = spawn(process.execPath, [process.argv[1], childRole], { detached: true, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  child.once("message", value => { child.disconnect(); child.unref(); resolve(value); });
});
if (role === "mcp") {
  setInterval(() => {}, 1000); process.send({ pid: process.pid });
} else if (role === "server") {
  const mcps = await Promise.all([start("mcp"), start("mcp")]);
  setInterval(() => {}, 1000); process.send({ server: process.pid, mcps: mcps.map(child => child.pid) });
} else {
  const tree = await start("server");
  writeFileSync(process.env.FIXTURE_TREE_REPORT, JSON.stringify({ root: process.pid, ...tree }));
  let next = 0;
  const lines = readline.createInterface({ input: process.stdin });
  lines.on("line", line => {
    const { id, method } = JSON.parse(line);
    let result = {};
    if (method === "initialize") { result = { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } } }; }
    else if (method === "session/new") { result = { sessionId: `root-${++next}`, pid: process.pid }; }
    if (id !== undefined) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`); }
  });
  // EOF is the sole stop trigger. Descendants deliberately outlive this root.
  process.on("SIGTERM", () => {});
  process.stdin.on("end", () => { writeFileSync(`${process.env.FIXTURE_TREE_REPORT}.eof`, "EOF"); process.exit(0); });
}
