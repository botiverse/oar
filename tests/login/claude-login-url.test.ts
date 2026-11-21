import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { onTestFinished, test } from "vitest";
import { claudeLogin } from "../../packages/oar/src/runtimes/claude/login.js";
import { fakeLoginCli } from "../fixtures/login-fixtures.js";
import { recordedInteraction } from "../fixtures/login-interaction.js";

const code = "fixture-code#fixture-state";
const compactLink = `https://claude.ai/oauth/authorize?AB${"x".repeat(43)}`;
const consoleLink = "https://platform.claude.com/oauth/authorize?client_id=fixture&response_type=code&state=fixture-state&code_challenge=fixture-challenge&code_challenge_method=S256&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback";

function recordingCli(state: Record<string, unknown>): ReturnType<typeof fakeLoginCli> {
  const dir = mkdtempSync(path.join(tmpdir(), "oar-claude-login-url-"));
  onTestFinished(() => { rmSync(dir, { recursive: true, force: true }); });
  return fakeLoginCli({ dir, name: "claude", script: "fake-claude-login.mjs", state });
}

test.each([
  { name: "next-line compact URL", url: compactLink, stdoutLines: ["If the browser didn't open, visit:", "{link}"] },
  { name: "unrelated text around a Console URL", url: consoleLink, stdoutLines: ["Read https://example.invalid/help first.", "For this account, open ({link}) to sign in."] },
  { name: "paste prompt without a valid URL", url: undefined, stdoutLines: [
    "If the browser didn't open, visit: https://claude.ai/help",
    "https://claude.ai/oauth/authorize?help",
    "https://platform.claude.com/oauth/authorize?client_id=fixture",
    consoleLink.replace("platform.claude.com/", "example.invalid/"),
  ] },
])("Claude sign-in with $name", async ({ url, stdoutLines }) => {
  const fake = recordingCli({ url, stdoutLines, code });
  const interaction = recordedInteraction([code]);
  const result = await claudeLogin({ kind: "available", via: "executable", command: fake.command }, interaction, { timeoutMs: 5000 });
  if (url === undefined) {
    assert.deepEqual(result, { kind: "failed", reason: "process_failed", detail: "login_url_missing: Claude requested a code before providing a recognized sign-in URL" });
    assert.deepEqual([interaction.events, interaction.prompts, fake.read().received], [[], [], []]);
  } else {
    assert.equal(result.kind, "logged_in");
    assert.deepEqual(interaction.events.filter((event) => event.kind === "auth_url").map((event) => event.url), [url]);
    assert.equal(interaction.prompts.length, 1);
  }
});
