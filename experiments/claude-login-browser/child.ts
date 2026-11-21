/** Separate process so the probe's isolated environment is in place before OAR loads. */
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { claudeLogin } from "../../packages/oar/src/runtimes/claude/login.js";
import { claudeAuthStatus } from "../../packages/oar/src/runtimes/claude/auth-status.js";
import { CODE } from "./mock.js";

const [command, version, mode] = process.argv.slice(2);
assert.ok(command !== undefined && version !== undefined);
const installation = { kind: "available", via: "executable", command, version } as const;
let state = "";
let urls = 0;
let prompts = 0;
const before = process.env.BROWSER;
// Check the unmodified remote handoff too. The synthetic exchange below needs
// the expanded URL to verify the challenge and state independently.
const nativeHandoff: string[] = [];
if (mode === "suppressed") {
  const abort = new AbortController();
  const handoff = await claudeLogin(installation, {
    signal: abort.signal,
    onEvent(event) {
      if (event.kind === "auth_url") {
        const link = new URL(event.url);
        nativeHandoff.push(link.searchParams.has("state") ? "expanded" : "compact");
      }
    },
    async prompt(request) {
      assert.equal(request.kind, "manual_code");
      assert.equal(nativeHandoff.length, 1);
      abort.abort();
      // As on the web, cancellation ends the login while the user has yet to answer.
      await Promise.withResolvers<void>().promise;
      return "";
    },
  }, { openBrowser: false, timeoutMs: 30_000 });
  assert.equal(handoff.kind, "cancelled");
}

const result = await claudeLogin(installation, {
  onEvent(event) {
    if (event.kind === "auth_url") {
      const url = new URL(event.url);
      state = url.searchParams.get("state") ?? "";
      const challenge = url.searchParams.get("code_challenge") ?? "";
      assert.ok(state !== "" && challenge !== "");
      urls += 1;
      // Private IPC to the local mock, never part of the saved report.
      process.send?.({ kind: "authorization", state, challenge });
    }
  },
  async prompt(request) {
    assert.equal(request.kind, "manual_code");
    prompts += 1;
    // Native Claude prints the URL before spawning BROWSER. Let that spawn run
    // before completing the exchange, so a fast login cannot hide an opener.
    await sleep(750);
    return `${CODE}#${state}`;
  },
}, { env: { CLAUDE_CODE_FULL_SIGN_IN_LINK: "1" }, timeoutMs: 30_000, ...(mode === "suppressed" ? { openBrowser: false } : {}) });
const status = await claudeAuthStatus(installation);
assert.equal(process.env.BROWSER, before);
process.send?.({ kind: "result", login: result.kind, status: status.kind, urls, prompts, nativeHandoff: nativeHandoff[0],
  ...(result.kind === "failed" ? { failure: result.reason, detail: result.detail } : {}) });
process.disconnect?.();
