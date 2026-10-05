/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument -- Standalone untyped fixture executable. */
// `morph console serve` as far as OAR's Console discovery sees it: serves
// `/runtime/health` on an ephemeral loopback port, publishes it in
// `<cwd>/console/runtime.json` (the state directory is its cwd), notes each
// start in `<cwd>/starts.log`, and removes the file when stopped.
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const published = join(process.cwd(), "console", "runtime.json");
const server = createServer((request, response) => {
  const ok = request.url === "/runtime/health" && request.headers.authorization === "Bearer fake-token";
  response.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
  response.end(JSON.stringify(ok ? { ok: true, mode: "console" } : { error: "not found" }));
});
server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  mkdirSync(join(process.cwd(), "console"), { recursive: true });
  appendFileSync(join(process.cwd(), "starts.log"), `${process.argv.slice(2).join(" ")}\n`);
  writeFileSync(published, JSON.stringify({ url: `http://127.0.0.1:${String(port)}/runtime`, token: "fake-token" }));
});
process.on("SIGTERM", () => {
  rmSync(published, { force: true });
  process.exit(0);
});
