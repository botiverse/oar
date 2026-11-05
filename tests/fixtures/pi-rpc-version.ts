import { writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

// A protocol fixture, not a replacement for the native version matrix.
if (process.argv.includes("--version")) {
  process.stdout.write("1.5.0\n");
} else {
  const directory = process.env.OAR_PI_RPC_DIRECTORY;
  if (directory === undefined) { throw new Error("Missing private fixture directory"); }
  writeFileSync(path.join(directory, "ready"), JSON.stringify({ modelRegistered: true, version: process.env.OAR_TEST_PI_READY_VERSION }));
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    const message: unknown = JSON.parse(line);
    if (typeof message !== "object" || message === null || !("type" in message) || !("id" in message)) { return; }
    const data = message.type === "get_state" ? { sessionId: "version-fixture", thinkingLevel: "off" } : {};
    process.stdout.write(`${JSON.stringify({ type: "response", command: message.type, id: message.id, success: true, data })}\n`);
  });
}
