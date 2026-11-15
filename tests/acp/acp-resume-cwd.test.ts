import { mkdtempSync, realpathSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { ResumeCwdError, UnsupportedOptionError } from "../../packages/oar/src/index.js";
import { acpSession } from "../../packages/oar/src/shared/acp/session.js";
import { fixture, profile } from "../fixtures/acp-session-support.js";

// kimi 2.1.1 resumed a session named in another directory and ran its shell in
// the session's own (probed 2026-10-03); the profile flag makes OAR read the
// session's directory from `session/list` and refuse the resume elsewhere.
const installation = { kind: "available", via: "executable", command: process.execPath } as const;
function scratch(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return realpathSync(dir);
}
const own = scratch("oar-acp-own-");
const other = scratch("oar-acp-other-");
const listed = profile({ args: [fixture, "listed"], resumeKeepsSessionCwd: true });
const env = { FAKE_ACP_SESSION_CWD: own };

test("a resume in another directory is refused, naming both", async () => {
  const opening = acpSession(listed)(installation, { cwd: other, resume: "fake-session", env });
  await expect(opening).rejects.toBeInstanceOf(ResumeCwdError);
  await expect(opening).rejects.toBeInstanceOf(UnsupportedOptionError);
  await expect(opening).rejects.toMatchObject({
    name: "UnsupportedOptionError", option: "cwd", reason: "other_cwd",
    sessionId: "fake-session", requestedCwd: other, savedCwd: own,
    message: `session fake-session lives in ${own} and this runtime resumes it only there; the resume names ${other}`,
  });
});

test("a resume in the session's own directory opens", async () => {
  const session = await acpSession(listed)(installation, { cwd: own, resume: "fake-session", env });
  expect(session.id).toBe("fake-session");
  await session.dispose();
});

test("without the flag the resume is not checked", async () => {
  const session = await acpSession(profile({ args: [fixture, "listed"] }))(installation, { cwd: other, resume: "fake-session", env });
  expect(session.id).toBe("fake-session");
  await session.dispose();
});

const unknownCases = [
  { reason: "listing_unavailable", scenario: { list: false } },
  { reason: "not_listed", scenario: { pages: [{ result: { sessions: [] } }] } },
  { reason: "not_listed", scenario: { pages: [
    { result: { sessions: [{ sessionId: "other", cwd: own }], nextCursor: "page2" } },
    { result: { sessions: [] } },
  ] } },
  ...[undefined, "", null, 3].map((cwd) => ({ reason: "cwd_unreported", scenario: { pages: [{ result: { sessions: [{ sessionId: "fake-session", cwd }] } }] } })),
  { reason: "listing_unavailable", scenario: { pages: [{ result: { sessions: [], nextCursor: "again" } }] } },
  { reason: "listing_unavailable", scenario: { pages: [
    { result: { sessions: [], nextCursor: "a" } }, { result: { sessions: [], nextCursor: "b" } }, { result: { sessions: [], nextCursor: "a" } },
  ] } },
  { reason: "listing_unavailable", scenario: { pages: [{ result: { sessions: [], nextCursor: 1 } }] } },
  ...[null, {}, { sessions: {} }, { sessions: [null] }, { sessions: [{ sessionId: "" }] }, { sessions: [{ sessionId: 7 }] }]
    .map((result) => ({ reason: "listing_unavailable", scenario: { pages: [{ result }] } })),
];
const guarded = profile({
  args: [fileURLToPath(new URL("../fixtures/fake-acp-missing-resume.mjs", import.meta.url))],
  resumeKeepsSessionCwd: true,
});
function expectUnknownCwd(failure: unknown, reason: string): void {
  expect(failure).toBeInstanceOf(ResumeCwdError);
  expect(failure).toBeInstanceOf(UnsupportedOptionError);
  expect(failure).toMatchObject({
    name: "UnsupportedOptionError", option: "cwd", reason, sessionId: "fake-session", requestedCwd: own,
    message: "cannot confirm the saved directory of session fake-session; this runtime resumes in its saved directory, so open a new session instead",
  });
  expect(failure).not.toHaveProperty("savedCwd");
}
test.each(unknownCases)("unknown saved cwd refuses before any resume or load: %j", async ({ reason, scenario }) => {
  const dir = scratch("oar-acp-cwd-guard-");
  const log = path.join(dir, "calls.txt");
  try {
    const opening = acpSession(guarded)(installation, { cwd: own, resume: "fake-session", env: {
      FAKE_RESUME_CASE: JSON.stringify({ ...scenario, succeed: true }), FAKE_ACP_CALL_LOG: log,
    } });
    const failure: unknown = await opening.then(async (unexpected) => { await unexpected.dispose(); return null; }, (error: unknown) => error);
    expectUnknownCwd(failure, reason);
    const calls = readFileSync(log, "utf8").trim().split("\n");
    expect(calls).not.toContain("session/resume");
    expect(calls).not.toContain("session/load");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
