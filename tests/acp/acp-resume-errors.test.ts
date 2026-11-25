/* oxlint-disable import/max-dependencies -- Covered ACP runtime profiles plus fixture/helper imports. */
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { inspect } from "node:util";
import { captureCleanupEvidence, expectCleanupEvidence } from "../fixtures/cleanup-evidence.js";
import { cleanupFailureReason } from "../../packages/oar/src/shared/executable/process-cleanup-diagnostics.js";
import { ResumeCwdError, UnsupportedOptionError } from "../../packages/oar/src/index.js";
import { acpSession } from "../../packages/oar/src/shared/acp/session.js";
import { antigravityAcpProfile } from "../../packages/oar/src/runtimes/antigravity/session.js";
import { devinAcpProfile } from "../../packages/oar/src/runtimes/devin/session.js";
import { kimiAcpProfile } from "../../packages/oar/src/runtimes/kimi/session.js";
import { opencodeAcpProfile, opencodeV2AcpProfile, opencodeBackgroundChildProfile } from "../../packages/oar/src/runtimes/opencode/session.js";

afterEach(() => { vi.restoreAllMocks(); });

const installation = { kind: "available", via: "executable", command: process.execPath } as const;
const fixture = fileURLToPath(new URL("../fixtures/fake-acp-missing-resume.mjs", import.meta.url));
const listingFailures = [
  { name: "authentication", scenario: { pages: [{ error: { code: -32_000, message: "Authentication required" } }] }, expected: { name: "RuntimeFailureError", failure: "auth", cause: { method: "session/list", native: { code: -32_000 } } } },
  { name: "RPC error", scenario: { pages: [{ error: { code: -32_603, message: "listing unavailable" } }] }, expected: { code: -32_603, message: "listing unavailable", cause: { method: "session/list", native: { code: -32_603 } } } },
  { name: "process exit", scenario: { exitOnList: 17 }, expected: { name: "AcpError", kind: "process_exited", exitCode: 17 } },
];
function scratch(prefix: string): string {
  const temporary = mkdtempSync(path.join(tmpdir(), prefix));
  return realpathSync(temporary);
}
function expectTypedRefusal(failure: unknown, reason: string, dir: string): void {
  expect(failure).toBeInstanceOf(ResumeCwdError);
  expect(failure).toBeInstanceOf(UnsupportedOptionError);
  expect(failure).toMatchObject({ reason, option: "cwd", sessionId: "missing-session", requestedCwd: dir });
  if (reason === "other_cwd") { expect(failure).toHaveProperty("savedCwd", path.join(dir, "elsewhere")); }
  else { expect(failure).not.toHaveProperty("savedCwd"); }
}
const guardedProfiles = [
  ["antigravity", antigravityAcpProfile],
  ["devin", devinAcpProfile],
  ["kimi", kimiAcpProfile],
  ["opencode v1", opencodeAcpProfile],
  ["opencode v2", opencodeV2AcpProfile],
  ["opencode background", opencodeBackgroundChildProfile],
] as const;

test("all ACP profiles that keep saved cwd enable the shared resume-cwd guard", () => {
  for (const [name, native] of guardedProfiles) {
    expect(native.resumeKeepsSessionCwd, name).toBe(true);
  }
});

test.each(guardedProfiles.filter(([name]) => name !== "antigravity"))("%s treats percent escapes in session/list as literal", async (_name, native) => {
  const root = scratch("oar-acp-literal-cwd-");
  try {
    const cwd = path.join(root, "my project");
    mkdirSync(cwd);
    const savedCwd = pathToFileURL(cwd).pathname;
    const sessions = [{ sessionId: "missing-session", cwd: savedCwd }];
    const opening = acpSession({ ...native, args: [fixture] })(installation, { cwd, resume: "missing-session", env: {
      FAKE_RESUME_CASE: JSON.stringify({ succeed: true, pages: [{ result: { sessions } }] }),
    } });
    await expect(opening.then(async (session) => session.dispose())).rejects.toMatchObject({ reason: "other_cwd", requestedCwd: cwd, savedCwd });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// All guarded profiles share acpSession's resumeKeepsSessionCwd path; one profile covers the process checks.
const representative = opencodeV2AcpProfile;
test.each(["not_listed", "other_cwd", "cwd_unreported", "listing_unavailable"] as const)("ACP resume guard exposes the typed %s refusal before resume/load", async (reason) => {
  const dir = scratch("oar-acp-cwd-reason-");
  const log = path.join(dir, "calls.txt");
  const rows = reason === "not_listed" ? [] : [{ sessionId: "missing-session", ...(reason === "other_cwd" ? { cwd: path.join(dir, "elsewhere") } : {}) }];
  try {
    const opening = acpSession({ ...representative, args: [fixture] })(installation, { cwd: dir, resume: "missing-session", env: {
      FAKE_RESUME_CASE: JSON.stringify({ succeed: true, list: reason !== "listing_unavailable", pages: [{ result: { sessions: rows } }] }), FAKE_ACP_CALL_LOG: log,
    } });
    const failure: unknown = await opening.then(async (session) => { await session.dispose(); return null; }, (error: unknown) => error);
    expectTypedRefusal(failure, reason, dir);
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(reason === "listing_unavailable" ? ["initialize"] : ["initialize", "session/list"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
// oxlint-disable-next-line eslint/max-statements -- Keep native error and the same operation's cleanup evidence together.
test.each(listingFailures)("ACP resume guard preserves listing $name and never resumes", async ({ scenario, expected }) => {
  const cleanupEvidence = captureCleanupEvidence();
  const temporary = mkdtempSync(path.join(tmpdir(), "oar-acp-cwd-list-error-"));
  const dir = realpathSync(temporary);
  const log = path.join(dir, "calls.txt");
  try {
    const opening = acpSession({ ...representative, args: [fixture] })(installation, { cwd: dir, resume: "missing-session", env: {
      FAKE_RESUME_CASE: JSON.stringify({ succeed: true, ...scenario }), FAKE_ACP_CALL_LOG: log,
    } });
    const failure: unknown = await opening.then(async (session) => { await session.dispose(); return null; }, (error: unknown) => error);
    const cleanup = "exitOnList" in scenario ? undefined : cleanupEvidence();
    const reason = cleanupFailureReason(cleanup);
    if (cleanup !== undefined) { expectCleanupEvidence(cleanup, reason); }
    const diagnostic = inspect(failure, { depth: 8, breakLength: Infinity });
    expect(failure, diagnostic).not.toBeInstanceOf(UnsupportedOptionError);
    expect(failure, diagnostic).toMatchObject({ ...expected,
      ...("message" in expected ? { message: `${expected.message}${reason === undefined ? "" : `; ${reason}`}` } : {}),
    });
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["initialize", "session/list"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

