/**
 * G4a negative control: `localAccountSlot` must actually reach the accountKey
 * hash (not be ignored), and the default `"local"` must reproduce the
 * pre-change key values (non-breaking).
 *
 * The "different slots → different keys" asserts are real teeth: if any
 * project* dropped the param and re-hardcoded `"local"`, both slots would
 * collapse to the same key and these `notEqual`s go red.
 *
 * The pre-change key constants below were computed against the hardcoded
 * `"..\0local.."` inputs that existed before slot threading.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { projectCodexRateLimitsReadSnapshot } from "./codexAccount.js";
import { projectKimiUsageSnapshot } from "./kimiAccount.js";
import { projectClaudeUsageTextSnapshot } from "./claudeAccount.js";
import { unsupportedUsageSnapshot } from "../../accountUsage.js";

// raft zod schema for accountKey (slock packages/shared/src/runtimeAccountUsage.ts:79).
const ACCOUNT_KEY_RE = /^[a-f0-9]{64}$/;

// sha256 of the exact pre-change hardcoded inputs.
const CODEX_LOCAL_KEY = "2833199c8f1a9b3e0cc1cc947318e5e22f6ad76a434f3cf053db80e1a454b8bc"; // "codex\0local"
const CLAUDE_LOCAL_KEY = "a203f714ab0e9791ed9bfc2ca53861261b51b24e9453f5e5a6ff2b6c7287bd44"; // "claude\0local"
const KIMI_LOCAL_STATUS_KEY =
  "dfbc81f3f6e7590562cc498bb055076dd4f5b8fdb680864cc52a617e1254f524"; // "kimi\0local\0status"
const GROK_LOCAL_KEY = "abbcc0a0b6fa420c47775197fbb1bb8b68f9a17324f65c71e7453c2f8a50007d"; // "grok\0local"

function codexKey(localAccountSlot?: string): string {
  const snap = projectCodexRateLimitsReadSnapshot({
    outcome: { kind: "reauth_required" },
    collectorVersion: "test",
    observedAtMs: 1_700_000_000_000,
    ...(localAccountSlot !== undefined ? { localAccountSlot } : {}),
  });
  return snap.accounts[0]!.accountKey;
}

function kimiStatusKey(localAccountSlot?: string): string {
  const snap = projectKimiUsageSnapshot({
    outcome: { kind: "error" },
    collectorVersion: "test",
    observedAtMs: 1_700_000_000_000,
    ...(localAccountSlot !== undefined ? { localAccountSlot } : {}),
  });
  return snap.accounts[0]!.accountKey;
}

function claudeKey(localAccountSlot?: string): string {
  const snap = projectClaudeUsageTextSnapshot({
    text: "no percent lines here",
    collectorVersion: "test",
    observedAtMs: 1_700_000_000_000,
    ...(localAccountSlot !== undefined ? { localAccountSlot } : {}),
  });
  return snap.accounts[0]!.accountKey;
}

test("codex accountKey: default reproduces pre-change key; distinct slots differ", () => {
  // Non-breaking: omitting the param and passing "local" both yield the old key.
  assert.equal(codexKey(), CODEX_LOCAL_KEY);
  assert.equal(codexKey("local"), CODEX_LOCAL_KEY);
  // Real tooth: the param must reach the hash.
  assert.notEqual(codexKey("slot-a"), codexKey("slot-b"));
  assert.notEqual(codexKey("slot-a"), CODEX_LOCAL_KEY);
});

test("kimi accountKey: default reproduces pre-change key; distinct slots differ", () => {
  assert.equal(kimiStatusKey(), KIMI_LOCAL_STATUS_KEY);
  assert.equal(kimiStatusKey("local"), KIMI_LOCAL_STATUS_KEY);
  assert.notEqual(kimiStatusKey("slot-a"), kimiStatusKey("slot-b"));
  assert.notEqual(kimiStatusKey("slot-a"), KIMI_LOCAL_STATUS_KEY);
});

test("claude accountKey: default reproduces pre-change key; distinct slots differ", () => {
  assert.equal(claudeKey(), CLAUDE_LOCAL_KEY);
  assert.equal(claudeKey("local"), CLAUDE_LOCAL_KEY);
  assert.notEqual(claudeKey("slot-a"), claudeKey("slot-b"));
  assert.notEqual(claudeKey("slot-a"), CLAUDE_LOCAL_KEY);
});

function grokUnsupportedKey(localAccountSlot?: string): string {
  const snap = unsupportedUsageSnapshot(
    "grok",
    "test",
    1_700_000_000_000,
    "no_programmable_usage_surface",
    localAccountSlot,
  );
  return snap.accounts[0]!.accountKey;
}

test("grok/unsupported accountKey is valid 64-hex and slot-sensitive", () => {
  // Real tooth: the old `${provider}_unsupported` literal ("grok_unsupported")
  // would fail this regex — it violates raft's zod schema (slock
  // packages/shared/src/runtimeAccountUsage.ts:79). Passing means the key is now
  // a sha256 hex digest.
  assert.match(grokUnsupportedKey(), ACCOUNT_KEY_RE);
  assert.match(grokUnsupportedKey("slot-a"), ACCOUNT_KEY_RE);
  // Non-breaking default: omitting the param and passing "local" both yield the
  // canonical `sha256("grok\0local")`.
  assert.equal(grokUnsupportedKey(), GROK_LOCAL_KEY);
  assert.equal(grokUnsupportedKey("local"), GROK_LOCAL_KEY);
  // Real tooth: the slot must reach the hash (not be dropped/hardcoded).
  assert.notEqual(grokUnsupportedKey("slot-a"), grokUnsupportedKey("slot-b"));
  assert.notEqual(grokUnsupportedKey("slot-a"), GROK_LOCAL_KEY);
});
