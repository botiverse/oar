import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { antigravityRuntime } from "../../packages/oar/src/runtimes/antigravity/index.js";
import { antigravityAccountUsage, projectAntigravityCredits, projectAntigravityUsage } from "../../packages/oar/src/runtimes/antigravity/account-usage.js";

// agy 1.5.7's own `-p "/usage" --output-format json` answer on a signed-in machine (2026-11-12), identifiers removed.
const recorded: unknown = JSON.parse(readFileSync(path.join(import.meta.dirname, "agy-1.5.7-usage.json"), "utf8"));

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) { rmSync(dir, { recursive: true, force: true }); } });

/** What the fake `agy models` does: signed in, signed out, or failing for another reason. */
const MODELS: Readonly<Record<string, string>> = {
  true: "echo gemini-3.8-flash; exit 0",
  false: "echo 'Please sign in to view available models' >&2; exit 1",
  broken: "echo 'network unreachable' >&2; exit 3",
};

/** A fake agy: `models` answers as signed in or out; `-p /usage` prints the recorded reply. Calls are logged. */
function fakeAgy(signedIn: boolean | "broken", reply: unknown = recorded) {
  const dir = mkdtempSync(path.join(tmpdir(), "oar-agy-usage-"));
  dirs.push(dir);
  const replyFile = path.join(dir, "reply.json");
  const calls = path.join(dir, "calls.txt");
  writeFileSync(replyFile, JSON.stringify(reply));
  const command = path.join(dir, "agy");
  writeFileSync(command, [
    "#!/bin/sh",
    `echo "$*" >> '${calls}'`,
    `if [ "$1" = models ]; then ${MODELS[String(signedIn)] ?? ""}; fi`,
    `if [ "$1" = -p ] && [ "$2" = /usage ]; then cat '${replyFile}'; exit 0; fi`,
    `if [ "$1" = -p ] && [ "$2" = /credits ]; then echo '{"status":"SUCCESS","command":{"name":"credits","data":{"remaining_credits":0}}}'; exit 0; fi`,
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

/** The recorded reply with the given buckets used up. */
function withUsedUp(...fractions: readonly string[]): unknown {
  let text = JSON.stringify(recorded);
  for (const fraction of fractions) { text = text.replace(`"remaining_fraction":${fraction}`, '"remaining_fraction":0'); }
  return JSON.parse(text);
}
const GEMINI_5H = "0.9498270153999329";
const THIRD_PARTY_WEEKLY = "1";

test("rate limited only when every group is used up and agy reports no AI credits", () => {
  expect(projectAntigravityUsage(withUsedUp(GEMINI_5H), 0)).toMatchObject({ rateLimited: false });
  const allGone = withUsedUp(GEMINI_5H, THIRD_PARTY_WEEKLY);
  expect(projectAntigravityUsage(allGone, 0)).toMatchObject({ rateLimited: true });
  for (const credits of [undefined, null, 3]) {
    expect(projectAntigravityUsage(allGone, credits)).toMatchObject({ rateLimited: false });
  }
});

test("an error answer or no bucket rejects, without repeating agy's status word", () => {
  expect(() => projectAntigravityUsage({ status: "ERROR synthetic-detail", error: "authentication failed" })).toThrow(/^Antigravity account usage: agy did not answer SUCCESS$/u);
  expect(() => projectAntigravityUsage({ status: "SUCCESS", command: { name: "usage", data: { groups: [] } } })).toThrow(/no usable quota buckets/u);
});

test("an unknown window name gives no duration, even one an object prototype holds", () => {
  const odd: unknown = JSON.parse(JSON.stringify(recorded).replace('"window":"5h"', '"window":"toString"'));
  const snapshot = projectAntigravityUsage(odd);
  expect(snapshot.kind === "available" ? snapshot.windows[1] : undefined).not.toHaveProperty("durationMs");
});

test("agy's /credits answer: the number, or null when it does not say", () => {
  // agy 1.5.7's own `-p "/credits" --output-format json` answer on the same signed-in machine.
  const credits: unknown = JSON.parse(readFileSync(path.join(import.meta.dirname, "agy-1.5.7-credits.json"), "utf8"));
  expect(projectAntigravityCredits(credits)).toBe(0);
  expect(projectAntigravityCredits({ status: "ERROR" })).toBeNull();
});

test("a sliver of quota left is not used up", () => {
  const sliver: unknown = JSON.parse(JSON.stringify(recorded).replace('"remaining_fraction":0.9498270153999329', '"remaining_fraction":1e-9'));
  const snapshot = projectAntigravityUsage(sliver);
  expect(snapshot).toMatchObject({ kind: "available", rateLimited: false });
  expect(snapshot.kind === "available" ? snapshot.windows[1]?.usedRatio : undefined).toBe(0.999999);
});

test.skipIf(process.platform === "win32")("signed out: reauth_required, and /usage (which would start a login) never runs", async () => {
  const agy = fakeAgy(false);
  expect(await antigravityAccountUsage(agy.installation)).toEqual({ kind: "reauth_required", reason: "not_authenticated" });
  expect(agy.calls()).toEqual(["models"]);
});

test.skipIf(process.platform === "win32")("a login agy models cannot confirm rejects, and /usage never runs", async () => {
  const agy = fakeAgy("broken");
  await expect(antigravityAccountUsage(agy.installation)).rejects.toThrow(/did not confirm a login/u);
  expect(agy.calls()).toEqual(["models"]);
});

test.skipIf(process.platform === "win32")("with every group used up, agy's /credits decides; otherwise it is never asked", async () => {
  const gone = fakeAgy(true, withUsedUp(GEMINI_5H, THIRD_PARTY_WEEKLY));
  expect(await antigravityAccountUsage(gone.installation)).toMatchObject({ kind: "available", rateLimited: true });
  expect(gone.calls()).toEqual(["models", "-p /usage --output-format json", "-p /credits --output-format json"]);
});
