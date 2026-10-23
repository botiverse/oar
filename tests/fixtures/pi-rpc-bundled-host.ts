import { createPiRuntime } from "../../packages/oar/src/runtimes/pi/index.js";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";

const [command] = process.argv.slice(2);
const runtime = createPiRuntime({ execution: "subprocess", ...(command === undefined ? {} : { command }) });
const installation = await runtime.installation();
if (installation.kind !== "available") { throw new Error("Bundled Pi unavailable"); }
const session = await runtime.session(installation, { cwd: process.cwd(), model: "aimock/aimock-thinking" });
try {
  const result = await promptAndWait(session, "bundled host hello", { timeoutMs: 30_000 });
  process.stdout.write(`${JSON.stringify({ result, context: session.contextUsage().value })}\n`);
} finally { await session.dispose(); }
