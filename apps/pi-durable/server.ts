import { startDemo } from "./host.js";

const demo = await startDemo(4748);
process.stdout.write(`Pi Durable browser demo: ${demo.url}\n`);
async function close(): Promise<void> { await demo.close(); process.exit(0); }
process.once("SIGINT", () => { void close(); });
process.once("SIGTERM", () => { void close(); });
