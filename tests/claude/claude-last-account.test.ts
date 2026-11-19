import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { claudeAuthStatus } from "../../packages/oar/src/runtimes/claude/auth-status.js";
import { runExecutable } from "../../packages/oar/src/shared/executable/index.js";

vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ runExecutable: vi.fn() }));
const installation = { kind: "available", via: "executable", command: "claude" } as const;
let home = "";
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "oar-remembered-"));
  vi.mocked(runExecutable).mockResolvedValue({ ok: false, exitCode: 1, stdout: '{"loggedIn":false}', stderr: "" });
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

test.each([
  [{ emailAddress: " old@example.invalid ", displayName: " Previous ", organizationUuid: "private" }, { email: "old@example.invalid", displayName: "Previous" }],
  [{ emailAddress: " ", displayName: "Only name" }, { displayName: "Only name" }],
  [{ emailAddress: "only@example.invalid" }, { email: "only@example.invalid" }],
  [{ organizationUuid: "private" }, undefined],
] as const)("reads the previous identity from only the selected profile fields", async (profile, expected) => {
  await writeFile(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: profile, unrelated: "private" }));
  const value = await claudeAuthStatus(installation, { env: { CLAUDE_CONFIG_DIR: home } });
  expect(value).toEqual({ kind: "logged_out", source: "claude auth status --json", ...(expected === undefined ? {} : { lastAccount: expected }) });
});

test("a logged-in status owns its identity even with a different stored profile", async () => {
  await writeFile(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "old@example.invalid" } }));
  vi.mocked(runExecutable).mockResolvedValue({ ok: true, exitCode: 0, stdout: '{"loggedIn":true,"email":"current@example.invalid"}', stderr: "" });
  expect(await claudeAuthStatus(installation, { env: { CLAUDE_CONFIG_DIR: home } })).toEqual({ kind: "logged_in", account: { email: "current@example.invalid" }, source: "claude auth status --json" });
});

test("missing and unreadable profiles leave the remembered identity absent", async () => {
  const options = { env: { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: null } };
  const empty = { kind: "logged_out", source: "claude auth status --json" };
  expect(await claudeAuthStatus(installation, options)).toEqual(empty);
  await writeFile(path.join(home, ".claude.json"), "incomplete");
  expect(await claudeAuthStatus(installation, options)).toEqual(empty);
});
