import { inspect } from "node:util";
import { expect, test } from "vitest";
import { bundled, fakeCursorRuntime } from "../fixtures/cursor-subprocess.js";

/*
 * The one-shot calls redact their answers and errors with the credentials in
 * the call's own `env`, as sessions do with theirs: also a key that does not
 * look like a token, also in an error's `cause` and in a child's stderr tail.
 * The fake SDK leaks the value into its error and stderr (`OAR_FAKE_LEAK`),
 * or exits with it on stderr (`OAR_FAKE_LEAK=exit`).
 */

const KEY = "plain cursor key 4815162342";
const SECRET = "plain status secret 2718281828";

function everything(value: unknown): string {
  return inspect(value, { depth: 20, showHidden: true });
}

async function listingError(leak: "throw" | "exit"): Promise<unknown> {
  try {
    await fakeCursorRuntime("subprocess").listModels(bundled, { env: { CURSOR_API_KEY: KEY, OAR_FAKE_LEAK: leak } });
  } catch (error) {
    return error;
  }
  throw new Error("the model listing did not fail");
}

test.each(["throw", "exit"] as const)("a model listing that fails with the key in its error or stderr (%s) leaks it nowhere, the cause included", async (leak) => {
  const error = await listingError(leak);
  expect(error).toMatchObject({ message: "Failed to list Cursor models" });
  const seen = everything(error);
  expect(seen).toContain("[redacted]");
  expect(seen).not.toContain(KEY);
});

test.each(["throw", "exit"] as const)("a status read that fails with a secret of the call's env (%s) leaks it nowhere", async (leak) => {
  const status = await fakeCursorRuntime("subprocess").authStatus(bundled, { env: { OAR_FAKE_LEAK_SECRET: SECRET, OAR_FAKE_LEAK: leak } });
  expect(status).toMatchObject({ kind: "unknown" });
  const seen = everything(status);
  expect(seen).toContain("[redacted]");
  expect(seen).not.toContain(SECRET);
});
