import { expect, test } from "vitest";
import { probeTerminalPriority } from "../harness/acp-terminal-priority.js";

for (const runtime of ["grok", "kimi", "codebuddy"] as const) {
  test.skipIf(process.platform !== "linux" || process.env.OAR_TEST !== `${runtime}-aimock`)(`${runtime}: a reverse terminal takes the wrapped native agent's OOM score before running`, async () => {
    const result = await probeTerminalPriority(runtime);
    expect(result.completed).toBe(true);
    expect(result.agentScore).toBeGreaterThan(result.hostScore);
    expect(result.commandScore).toBe(result.agentScore);
    expect(result.reverseRequests).toEqual(expect.arrayContaining(["terminal/create", "terminal/wait_for_exit", "terminal/output", "terminal/release"]));
  }, 90_000);
}
