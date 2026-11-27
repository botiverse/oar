import { fileURLToPath } from "node:url";
import { createPiRuntime } from "../../packages/oar/src/runtimes/pi/index.js";
import type { Session, SessionOptions } from "../../packages/oar/src/contracts/session.js";
import { claudeSession } from "../../packages/oar/src/runtimes/claude/session.js";
import { codexSession } from "../../packages/oar/src/runtimes/codex/session.js";
import { acpSession } from "../../packages/oar/src/shared/acp/session.js";
import { fixture as acpAgent, profile } from "./acp-session-support.js";
import { agentTreeModule, fakeAgentBinary } from "./process-tree.js";

type Open = (dir: string, options: SessionOptions) => Promise<Session>;

// Native transports opened against fixtures that publish their process tree.
export const processSessions: readonly (readonly [string, Open])[] = [
  ["claude", async (dir, options) => claudeSession({ kind: "available", via: "executable", command: fakeAgentBinary(dir) }, options)],
  ["codex", async (dir, options) => codexSession({ kind: "available", via: "executable", command: fakeAgentBinary(dir) }, options)],
  ["acp", async (dir, options) => acpSession(profile({ args: [] }))(
    { kind: "available", via: "executable", command: fakeAgentBinary(dir, ["--import", agentTreeModule, acpAgent, "session"]) },
    options,
  )],
];

const piFixture = fileURLToPath(new URL("pi-rpc-version.ts", import.meta.url));
export const piRpc: Open = async (dir, options) => {
  const runtime = createPiRuntime({ execution: "subprocess", command: process.execPath, args: [piFixture] });
  return runtime.session({ kind: "available", via: "executable", command: process.execPath }, { ...options, env: { ...options.env,
    OAR_TEST_PI_READY_VERSION: "1.5.0", PI_CODING_AGENT_DIR: dir } });
};
