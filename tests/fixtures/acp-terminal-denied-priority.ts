// Invoked through tsx: only this child changes priority, never the test host.
import { readFileSync, writeFileSync } from "node:fs";
import { createAcpTerminalHost } from "../../packages/oar/src/shared/acp/terminal.js";

const source = Number(process.argv[2]);
const nativeScore = Number(readFileSync(`/proc/${String(source)}/oom_score_adj`, "utf8"));
const raised = Math.max(500, nativeScore + 1);
writeFileSync("/proc/self/oom_score_adj", String(raised));
let denied = false;
try { writeFileSync("/proc/self/oom_score_adj", String(nativeScore)); }
catch { denied = true; }
const host = createAcpTerminalHost(process.cwd(), process.env, { agentPid: () => source });
try {
  const { terminalId } = await host.create({ sessionId: "denied", command: process.execPath, args: ["-e", "console.log(require('node:fs').readFileSync('/proc/self/oom_score_adj','utf8').trim())"] });
  const identity = { sessionId: "denied", terminalId };
  const exit = await host.waitForExit(identity);
  const score = Number(host.output(identity).output);
  console.log(JSON.stringify({ denied, score, expected: denied ? raised : nativeScore, exit }));
} finally { await host.dispose(); }
