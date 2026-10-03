import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { UnsupportedOptionError } from "../../packages/oar/src/index.js";
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
  await expect(opening).rejects.toBeInstanceOf(UnsupportedOptionError);
  await expect(opening).rejects.toMatchObject({
    option: "cwd",
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
