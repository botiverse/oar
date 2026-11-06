import { readFileSync } from "node:fs";
import path from "node:path";
import { resolveExecutable } from "../executable/resolve.js";

/** Linux reverse terminals inherit the agent's priority, not their host's. */
export function terminalLaunch(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, shell: boolean, agentPid?: number): { command: string; args: readonly string[]; shell: boolean } {
  const original = { command, args, shell };
  if (process.platform !== "linux" || agentPid === undefined || !Number.isSafeInteger(agentPid) || agentPid <= 0) { return original; }
  let score = "";
  try {
    score = readFileSync(`/proc/${String(agentPid)}/oom_score_adj`, "utf8").trim();
    if (score === readFileSync("/proc/self/oom_score_adj", "utf8").trim()) { return original; }
  }
  catch { return original; }
  if (!/^-?\d+$/u.test(score) || Number(score) < -1000 || Number(score) > 1000) { return original; }
  // Resolve relative PATH entries against the terminal cwd, not OAR's cwd.
  // Missing/non-executable commands keep spawn's existing error behavior.
  const target = shell ? "/bin/sh" : resolveExecutable(command.includes("/") ? path.resolve(cwd, command) : command, {
    ...env, PATH: (env.PATH ?? "/usr/bin:/bin").split(":").map(entry => path.resolve(cwd, entry)).join(":"),
  });
  if (target === null) { return original; }
  return {
    command: "/bin/sh",
    // Score and argv are separate arguments, never interpolated shell code.
    // A refused write (for example, lowering without privilege) leaves the
    // inherited value alone. exec retains the owned process group and PID.
    args: ["-c", String.raw`{ printf "%s\n" "$1" > /proc/self/oom_score_adj; } 2>/dev/null || :; shift; exec "$@"`, "oar-acp-terminal", score,
      target, ...(shell ? ["-c", command] : args)],
    shell: false,
  };
}
