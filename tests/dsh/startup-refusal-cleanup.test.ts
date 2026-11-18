import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import { dshRuntime, UnsupportedOptionError } from "../../packages/oar/src/index.js";
import { captureCleanupEvidence, expectCleanupEvidence } from "../fixtures/cleanup-evidence.js";
import { cleanupFailureReason } from "../../packages/oar/src/shared/executable/process-cleanup-diagnostics.js";
import { fakeAgentBinary } from "../fixtures/process-tree.js";

const dir = mkdtempSync(path.join(tmpdir(), "oar-dsh-refusal-"));
const command = fakeAgentBinary(dir, [path.resolve(import.meta.dirname, "../fixtures/fake-dsh.mjs")]);
afterAll(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); });
afterEach(() => { vi.restoreAllMocks(); });

async function failure(env: Record<string, string>, options: { readonly resume?: string }): Promise<unknown> {
  const result = await dshRuntime.session({ kind: "available", via: "executable", command, version: "0.2.1-rc.5" }, { cwd: dir, env, ...options }).then(
    async session => { await session.dispose(); return null; }, (error: unknown) => error,
  );
  return result;
}

test.each([
  ["create", "RuntimeFailureError", "opening a session"],
  ["resume", "UnsupportedOptionError", "resuming a session"],
  ["open", "UnsupportedOptionError", "reading a saved session before resume"],
])("missing factory %s is a typed refusal with its reason and observed cleanup", async (method, name, operation) => {
  const cleanupEvidence = captureCleanupEvidence();
  const error = await failure({ FAKE_DSH_MISSING: method }, method === "create" ? {} : { resume: "11111111-1111-4111-8111-111111111111" });
  const cleanup = cleanupEvidence();
  const reason = cleanupFailureReason(cleanup);
  expectCleanupEvidence(cleanup, reason);
  const diagnostic = inspect(error, { depth: 8, breakLength: Infinity });
  if (method !== "create") { expect(error, diagnostic).toBeInstanceOf(UnsupportedOptionError); }
  expect(error, diagnostic).toMatchObject({ name, ...(method === "create" ? {} : { option: "resume" }),
    message: `This DSH does not provide ${method}(), which ${operation} requires${reason === undefined ? "" : `; ${reason}`}`,
  });
});
