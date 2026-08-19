import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveClaudeCommand,
  CLAUDE_DESKTOP_CLI_SYSTEM_PATH,
  type ClaudeResolveDeps,
} from "./claudeCommandResolution.js";

function deps(over: Partial<ClaudeResolveDeps>): ClaudeResolveDeps {
  return {
    env: {},
    platform: "darwin",
    homeDir: "/home/x",
    which: () => null,
    exists: () => false,
    ...over,
  };
}

test("PATH claude wins outright", () => {
  const r = resolveClaudeCommand(deps({ which: () => "/usr/local/bin/claude" }));
  assert.equal(r, "/usr/local/bin/claude");
});

test("darwin: off-PATH falls back to ~/Applications desktop bundle", () => {
  const homeBundle = "/home/x/Applications/Claude Code URL Handler.app/Contents/MacOS/claude";
  const r = resolveClaudeCommand(deps({ which: () => null, exists: (p) => p === homeBundle }));
  assert.equal(r, homeBundle);
});

test("darwin: falls back to system /Applications bundle when only it exists", () => {
  const r = resolveClaudeCommand(
    deps({ which: () => null, exists: (p) => p === CLAUDE_DESKTOP_CLI_SYSTEM_PATH }),
  );
  assert.equal(r, CLAUDE_DESKTOP_CLI_SYSTEM_PATH);
});

test("non-darwin: no desktop fallback → null when off PATH", () => {
  const r = resolveClaudeCommand(deps({ platform: "linux", which: () => null, exists: () => true }));
  assert.equal(r, null);
});

test("nothing anywhere → null", () => {
  const r = resolveClaudeCommand(deps({}));
  assert.equal(r, null);
});
