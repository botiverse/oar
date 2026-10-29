import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { codebuddySession } from "../../packages/oar/src/runtimes/codebuddy/session.js";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import type { acpSession, AcpSessionProfile } from "../../packages/oar/src/shared/acp/session.js";

const captured = vi.hoisted((): { args: readonly string[] } => ({ args: [] }));
vi.mock("../../packages/oar/src/shared/acp/session.js", async (original) => {
  const module = await original<{ acpSession: typeof acpSession }>();
  return { ...module, acpSession: (profile: AcpSessionProfile) => module.acpSession({ ...profile, args: (options) => {
    captured.args = typeof profile.args === "function" ? profile.args(options) : profile.args;
    // Exercise the real shared process lifecycle, substituting only the vendor executable protocol.
    return [path.join(import.meta.dirname, "../fixtures/fake-acp-agent.mjs"), "session"];
  } }) };
});
afterEach(() => { captured.args = []; });
const installation = { kind: "available", via: "executable", command: process.execPath } as const;
const prompt = "private system prompt\r\n".repeat(6000);
function fileArgument(): string {
  expect(captured.args).toContain("--system-prompt-file");
  expect(captured.args).not.toContain(prompt);
  return captured.args[captured.args.indexOf("--system-prompt-file") + 1] ?? "";
}

function checkPrivatePrompt(file: string): void {
  expect(readFileSync(file, "utf8")).toBe(prompt);
  if (process.platform !== "win32") {
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  }
}

test.each(["dispose", "native exit"])("a long prompt stays private until %s, then its directory is removed", async (ending) => {
  const session = await codebuddySession(installation, { cwd: process.cwd(), systemPrompt: prompt });
  const file = fileArgument();
  const directory = path.dirname(file);
  try {
    checkPrivatePrompt(file);
    await (ending === "native exit" ? promptAndWait(session, "exit", { timeoutMs: 3000 }) : session.dispose());
    expect(existsSync(directory)).toBe(false);
  } finally { await session.dispose(); }
  expect(existsSync(directory)).toBe(false);
});

test("an opening failure removes the prepared prompt directory", async () => {
  await expect(codebuddySession({ ...installation, command: path.join(import.meta.dirname, "no-such-codebuddy") }, { cwd: process.cwd(), systemPrompt: prompt })).rejects.toThrow();
  const file = fileArgument();
  expect(existsSync(path.dirname(file))).toBe(false);
});
