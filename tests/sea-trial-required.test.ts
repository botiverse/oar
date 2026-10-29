import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { runExecutable } from "../packages/oar/src/shared/executable/run.js";

test.each([
  { backend: "grok-aimock", override: "OAR_GROK_BIN", required: "1" },
  { backend: "kimi-aimock", override: "OAR_KIMI_BIN", required: "1" },
  { backend: "opencode-aimock", override: "OAR_OPENCODE_BIN", required: "1" },
  { backend: "opencode-aimock", override: "OAR_OPENCODE_BIN", required: "" },
])("$backend absent installation with required=$required exits honestly", async ({ backend, override, required }) => {
  const root = await mkdtemp(path.join(tmpdir(), "oar-required-backend-"));
  try {
    const result = await runExecutable(process.execPath, ["--import", "tsx", "sea-trial/main.ts"], {
      env: { ...process.env, OAR_TEST: backend, OAR_TEST_REQUIRE_AVAILABLE: required, [override]: path.join(root, "missing-executable") },
      timeoutMs: 20_000,
    });
    const output = { stdout: `${backend}: not available (not_found), ${required === "1" ? "failing" : "skipping"}\n`, stderr: "" };
    expect(result).toMatchObject({ ok: required !== "1", exitCode: required === "1" ? 1 : null, ...output });
  } finally { await rm(root, { recursive: true, force: true }); }
});
