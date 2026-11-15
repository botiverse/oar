// Synthetic process driver for observer.test.ts. Never starts a vendor binary.
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { observeGrokProcesses } from "./observe-process.js";

if (process.env.OBSERVE !== "0") { observeGrokProcesses(() => ({ suite: "synthetic" })); }
if (process.env.SCENARIO === "spawn-error") {
  spawn(path.join(process.cwd(), "missing-synthetic-grok"), ["agent", "stdio"], { env: process.env });
} else {
  const fixture = fileURLToPath(new URL("observer-native-fixture.ts", import.meta.url));
  const child = spawn(process.execPath, [fixture, "agent", "stdio"], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let writes = 0;
  const returns: boolean[] = [];
  let input = "";
  let request = 0;
  const methods = ["initialize", "authenticate", "session/new", "session/prompt"];
  const send = (): void => {
    const method = methods[request++];
    if (method === undefined) { child.stdin.end(); return; }
    const line = `${JSON.stringify({ jsonrpc: "2.0", id: request, method, params: { token: "synthetic-auth-secret-123456789", text: process.env.SCENARIO === "backpressure" ? "p".repeat(512 * 1024) : "private-prompt-text", mcpServers: [{ env: { TEST_API_KEY: "synthetic-mcp-secret-123456789" } }] } })}\n`;
    returns.push(child.stdin.write(line.slice(0, 17), () => { writes += 1; }), child.stdin.write(line.slice(17), () => { writes += 1; }));
  };
  const timer = setTimeout(() => { child.kill("SIGKILL"); }, 10_000);
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    input += chunk.toString();
    let newline = input.indexOf("\n");
    while (newline >= 0) {
      const line = input.slice(0, newline); input = input.slice(newline + 1);
      if (line.startsWith('{"jsonrpc":')) { send(); }
      newline = input.indexOf("\n");
    }
  });
  let ready = false;
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    if (!ready && stderr.includes("fixture-ready\n")) { ready = true; send(); }
    if (stderr.includes("fixture-stalled\n")) { child.kill("SIGKILL"); }
  });
  const result: unknown[] = await once(child, "close");
  const [code, signal] = result;
  clearTimeout(timer);
  console.log(JSON.stringify({ code, signal, stdout, stderr, writes, returns }));
}
