import { createHash } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { bundled, fakeCursorRuntime, lastResult, printEnvironment, tempDirectory } from "../fixtures/cursor-subprocess.js";

/*
 * A session's CURSOR_API_KEY goes to the SDK as `apiKey`, not into the
 * child's environment: the agent's tool shells do not inherit it, the child's
 * `/proc/<pid>/environ` does not hold it, and the fake SDK still received it.
 * The key is deliberately not token-shaped.
 */

afterEach(() => { vi.unstubAllEnvs(); });

const KEY = "plain session key 4815162342";
const fingerprint = createHash("sha256").update(KEY).digest("hex");

async function run(envBase: "inherit" | "clean", prompts: readonly string[]): Promise<{ readonly results: unknown[]; readonly records: string }> {
  // `clean` gets what a host passes for Node and a shell; `inherit` has them already.
  const base = envBase === "clean" ? { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } : {};
  const session = await fakeCursorRuntime("subprocess", envBase).session(bundled, { cwd: tempDirectory(), env: { ...base, CURSOR_API_KEY: KEY } });
  const results: unknown[] = [];
  try {
    for (const input of prompts) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one run at a time.
      const prompt = await session.prompt(input);
      // oxlint-disable-next-line eslint/no-await-in-loop -- one run at a time.
      await awaitTurnEnd(session, prompt.seq);
      results.push(lastResult(session));
    }
  } finally {
    await session.dispose();
  }
  return { results, records: JSON.stringify(session.records()) };
}

test.each(["inherit", "clean"] as const)("%s: the SDK gets the session's CURSOR_API_KEY as apiKey; the agent's shell and the child's environment do not hold it", async (envBase) => {
  vi.stubEnv("CURSOR_API_KEY", undefined);
  const { results, records } = await run(envBase, ["apikey", `shell:${printEnvironment(["CURSOR_API_KEY"])}`, "childenv"]);
  expect(results).toEqual([
    fingerprint,
    JSON.stringify([null]),
    JSON.stringify([null, process.platform === "linux" ? false : null]),
  ]);
  expect(records).not.toContain(KEY);
});
