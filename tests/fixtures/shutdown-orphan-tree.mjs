/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument, typescript/no-unsafe-return -- Standalone native process fixture. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import readline from "node:readline";

const send = (value) => { process.stdout.write(`${JSON.stringify(value)}\n`); };

if (process.argv[2] === "middle") {
  const tool = spawn(process.execPath, ["-e", "setInterval(()=>{},1000);process.send('ready',()=>process.disconnect());"], {
    detached: true, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  let ready = false;
  tool.on("message", (value) => { ready = value === "ready"; });
  tool.on("disconnect", () => {
    if (!ready) { process.exit(2); }
    tool.unref(); process.send({ middle: process.pid, tool: tool.pid });
  });
  process.on("message", () => { process.exit(0); });
} else {
  const middle = spawn(process.execPath, [process.argv[1], "middle"], {
    detached: true, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const [ready] = await once(middle, "message");
  let orphaned = undefined;
  const orphan = async () => {
    orphaned ??= (async () => { const exited = once(middle, "exit"); middle.send("exit"); await exited; })();
    return orphaned;
  };
  const input = readline.createInterface({ input: process.stdin });
  if (process.argv[2] === "acp") {
    let prompt = undefined;
    // oxlint-disable-next-line eslint/max-statements -- Minimal protocol peer deliberately severs its tool parent during cancellation.
    input.on("line", (line) => { void (async () => {
      const request = JSON.parse(line);
      const reply = (result) => { send({ jsonrpc: "2.0", id: request.id, result }); };
      if (request.method === "initialize") { reply({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } } }); }
      else if (request.method === "session/new") { reply({ sessionId: "orphan-root" }); }
      else if (request.method === "session/prompt") {
        prompt = request.id;
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "orphan-root", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(ready) } } } });
      } else if (request.method === "session/cancel" || request.method === "session/close") {
        await orphan();
        if (prompt !== undefined) { send({ jsonrpc: "2.0", id: prompt, result: { stopReason: "cancelled" } }); prompt = undefined; }
        if (request.id !== undefined) { reply({}); }
      }
    })(); });
  } else {
    send(ready);
    input.on("line", () => { void (async () => { await orphan(); console.log("orphaned"); })(); });
  }
  input.on("close", () => { process.exit(0); });
}
