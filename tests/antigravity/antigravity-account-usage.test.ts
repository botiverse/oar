import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { antigravityRuntime } from "../../packages/oar/src/runtimes/antigravity/index.js";
import { antigravityAccountUsage, projectAntigravityUsage } from "../../packages/oar/src/runtimes/antigravity/account-usage.js";

// agy 1.5.7's own `-p "/usage" --output-format json` answer on a signed-in machine (2026-11-12), identifiers removed.
const recorded: unknown = JSON.parse(readFileSync(path.join(import.meta.dirname, "agy-1.5.7-usage.json"), "utf8"));

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) { rmSync(dir, { recursive: true, force: true }); } });

/** A fake agy: `models` answers as signed in or out; `-p /usage` prints the recorded reply. Calls are logged. */
function fakeAgy(signedIn: boolean) {
  const dir = mkdtempSync(path.join(tmpdir(), "oar-agy-usage-"));
  dirs.push(dir);
  const reply = path.join(dir, "reply.json");
  const calls = path.join(dir, "calls.txt");
  writeFileSync(reply, JSON.stringify(recorded));
  const command = path.join(dir, "agy");
  writeFileSync(command, [
    "#!/bin/sh",
    `echo "$*" >> '${calls}'`,
    `if [ "$1" = models ]; then ${signedIn ? "echo gemini-3.8-flash; exit 0" : "echo 'Please sign in to view available models' >&2; exit 1"}; fi`,
    `if [ "$1" = -p ] && [ "$2" = /usage ]; then cat '${reply}'; exit 0; fi`,
    "exit 2",
  ].join("\n"), { mode: 0o700 });
  return { installation: { kind: "available", via: "executable", command } as const, calls: () => readFileSync(calls, "utf8").trim().split("\n") };
}

test("antigravity declares account usage", () => {
  expect(antigravityRuntime.accountUsage).toBeDefined();
});

test("agy's model groups become windows, scoped to the group agy names", () => {
  expect(projectAntigravityUsage(recorded)).toEqual({
    kind: "available",
    rateLimited: false,
    windows: [
      { label: "Gemini Models · Weekly Limit Remaining", usedRatio: 0.022807, resetsAt: "2026-11-19T16:40:24.000Z", id: "gemini-weekly", durationMs: 604_800_000, scope: { kind: "models", name: "Gemini Models" } },
      { label: "Gemini Models · Five Hour Limit Remaining", usedRatio: 0.050173, resetsAt: "2026-11-12T21:40:24.000Z", id: "gemini-5h", durationMs: 18_000_000, scope: { kind: "models", name: "Gemini Models" } },
      { label: "Claude and GPT models · Weekly Limit Remaining", usedRatio: 0, resetsAt: "2026-11-19T17:40:11.000Z", id: "3p-weekly", durationMs: 604_800_000, scope: { kind: "models", name: "Claude and GPT models" } },
      { label: "Claude and GPT models · Five Hour Limit Remaining", usedRatio: 0, resetsAt: "2026-11-12T22:40:11.000Z", id: "3p-5h", durationMs: 18_000_000, scope: { kind: "models", name: "Claude and GPT models" } },
    ],
  });
});

test("an exhausted bucket is rate limited; an error answer or no bucket rejects", () => {
  // The recorded reply, its Gemini 5-hour bucket used up.
  const exhausted: unknown = JSON.parse(JSON.stringify(recorded).replace('"remaining_fraction":0.9498270153999329', '"remaining_fraction":0'));
  expect(projectAntigravityUsage(exhausted)).toMatchObject({ kind: "available", rateLimited: true });
  expect(() => projectAntigravityUsage({ status: "ERROR", error: "authentication failed or timed out" })).toThrow(/agy answered ERROR/u);
  expect(() => projectAntigravityUsage({ status: "SUCCESS", command: { name: "usage", data: { groups: [] } } })).toThrow(/no usable quota buckets/u);
});

test.skipIf(process.platform === "win32")("signed in: agy models, then agy's own /usage answer", async () => {
  const agy = fakeAgy(true);
  expect(await antigravityAccountUsage(agy.installation)).toMatchObject({ kind: "available", rateLimited: false });
  expect(agy.calls()).toEqual(["models", "-p /usage --output-format json"]);
});

test.skipIf(process.platform === "win32")("signed out: reauth_required, and /usage (which would start a login) never runs", async () => {
  const agy = fakeAgy(false);
  expect(await antigravityAccountUsage(agy.installation)).toEqual({ kind: "reauth_required", reason: "not_authenticated" });
  expect(agy.calls()).toEqual(["models"]);
});
