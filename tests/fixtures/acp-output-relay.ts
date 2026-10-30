import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { onTestFinished, vi } from "vitest";
import type { LineProcess } from "../../packages/oar/src/shared/executable/index.js";

const agentPath = fileURLToPath(new URL("fake-acp-shared.mjs", import.meta.url));
const relayPath = fileURLToPath(new URL("acp-output-relay.mjs", import.meta.url));

function outputRelay(agent: LineProcess) {
  const relay = spawn(process.execPath, [relayPath], { stdio: ["pipe", "pipe", "pipe"] });
  const closed = Promise.withResolvers<void>();
  relay.once("close", () => { closed.resolve(); }).on("error", () => {});
  // The relay deliberately exits before the agent closes its output.
  relay.stdin.on("error", () => {});
  relay.stderr.resume();
  agent.stdout.pipe(relay.stdin);
  return { stdout: relay.stdout, stop: () => { agent.stdout.unpipe(relay.stdin); relay.kill(); }, closed: closed.promise };
}

/** Keep real process ownership/stdin; only its output travels through another process. */
export default async function relayAcpOutput(): Promise<void> {
  const executable = await import("../../packages/oar/src/shared/executable/index.js");
  const start = executable.spawnLineProcess;
  const relays: { stop: () => void; closed: Promise<void> }[] = [];
  const spy = vi.spyOn(executable, "spawnLineProcess").mockImplementation((command, args, options) => {
    const agent = start(command, args, options);
    if (!args.includes(agentPath)) { return agent; }
    const relay = outputRelay(agent); relays.push(relay);
    return { ...agent, stdout: relay.stdout };
  });
  onTestFinished(async () => {
    spy.mockRestore();
    for (const relay of relays) { relay.stop(); }
    await Promise.all(relays.map(async relay => { await relay.closed; }));
  });
}
