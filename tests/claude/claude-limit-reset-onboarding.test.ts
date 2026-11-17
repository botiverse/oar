import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, test, vi } from "vitest";
import { createClaudeLimitResetDriver } from "../../packages/oar/src/runtimes/claude/limit-reset/driver.js";
import { onboardingScreen } from "../../packages/oar/src/runtimes/claude/limit-reset/onboarding.js";

const fixture = (name: string): string => readFileSync(new URL(`limit-reset-fixtures/${name}.txt`, import.meta.url), "utf8");
const theme = fixture("onboarding-theme");
const security = fixture("onboarding-security");
const trust = fixture("trust");
const prompt = fixture("prompt");
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const ignoreData = (): void => {};

function setup(pages: string[], nextDelay = 300) {
  let index = 0;
  let data: (chunk: string) => void = ignoreData;
  const writes: string[] = [];
  let killed = false;
  let yes = false;
  const paint = (text: string): void => { data(`\u001B[2J\u001B[H${text.replaceAll("\n", "\r\n")}`); };
  const driver = createClaudeLimitResetDriver({
    platform: "linux",
    cachedFlags: async () => ({ limitResets: true }),
    fiveHourLimit: async () => "unknown",
    workDir: async () => ({ path: "/synthetic-empty", remove: async () => {} }),
    openTerminal: () => {
      setTimeout(() => { paint(pages[0] ?? prompt); }, 100);
      return {
        onData: (listener) => { data = listener; },
        onExit: () => {},
        kill: async () => { killed = true; },
        write: (key) => {
          writes.push(key);
          if (pages[index] === trust && key === "\u001B[B") {
            yes = true;
            paint(trust.replace(" ❯ No, exit\n   Yes, I trust this folder", "   No, exit\n ❯ Yes, I trust this folder"));
          } else if (key === "\r" && (pages[index] !== trust || yes)) {
            index += 1;
            setTimeout(() => { paint(pages[index] ?? prompt); }, nextDelay);
          }
        },
      };
    },
  });
  return { driver, writes, paint, killed: () => killed };
}

test("only the complete recorded theme default and security notice are accepted", () => {
  assert.equal(onboardingScreen(theme), "theme");
  assert.equal(onboardingScreen(security), "security");
  assert.equal(onboardingScreen(security.replace("2.1.322", "2.1.326")), "security");
  for (const changed of [theme.replace("❯ ✔ Dark mode", "❯ ✔ Light mode"), `${theme}\nAgree to new terms`,
    security.replace("Press Enter to continue…", "Press Enter to agree"), security.replace("Claude can make mistakes.", "Allow data collection."),
    `Additional agreement\n${security}`, security.replace("Learn more: https://code.claude.com/docs/en/security", "")]) {
    assert.equal(onboardingScreen(changed), "unrecognised");
  }
});

for (const operation of ["read", "redeem"] as const) {
  test(`${operation}: completes onboarding once, then existing trust, recording the side effect`, async () => {
    const run = setup([theme, security, trust, prompt], 1500);
    const result = operation === "read"
      ? run.driver.read({ command: "claude", atFiveHourLimit: false })
      : run.driver.redeem({ command: "claude", kind: "weekly", idempotencyKey: "onboarding" });
    await vi.advanceTimersByTimeAsync(15_000);
    const report = await result;
    assert.deepEqual(report.result, { kind: "not_attempted", reason: "usage_unread", onboardingCompleted: true });
    assert.deepEqual(run.writes, ["\r", "\r", "\u001B[B", "\r"]);
    assert.equal(run.killed(), true);
  });
}

for (const [name, pages, keys] of [
  ["changed theme", [theme.replace("Dark mode", "Share usage data")], []],
  ["unknown login choice", [theme.replace("Choose the text style", "Select login method")], []],
  ["extra notice choice", [theme, `${security}\n1. Allow data collection\n2. Decline`], ["\r"]],
  ["changed notice", [security.replace("Claude can make mistakes.", "Accept these terms.")], []],
  ["additional page", [theme, security, theme], ["\r", "\r"]],
] as const) {
  test(`${name}: fails within settle windows, with no keys on the unknown page`, async () => {
    const run = setup([...pages]);
    let answered = false;
    const result = (async () => {
      const report = await run.driver.read({ command: "claude", atFiveHourLimit: false });
      answered = true;
      return report;
    })();
    await vi.advanceTimersByTimeAsync(12_000);
    assert.equal(answered, true, "must not wait for the 30 s startup or 75 s call timeout");
    const report = await result;
    assert.deepEqual(report.result, { kind: "not_attempted", reason: "startup_failed", startup: { screen: "onboarding", version: "2.1.322" } });
    assert.deepEqual(run.writes, keys);
    assert.equal(run.killed(), true);
  });
}

test("a page changed during settlement cannot receive the earlier page's Enter", async () => {
  const run = setup([theme]);
  const result = run.driver.read({ command: "claude", atFiveHourLimit: false });
  await vi.advanceTimersByTimeAsync(1000);
  run.paint(`${theme}\nAgree to data sharing`);
  await vi.advanceTimersByTimeAsync(5000);
  const report = await result;
  assert.equal(report.result.kind, "not_attempted");
  assert.deepEqual(run.writes, []);
});

test("security confirmation without a following trust/prompt is not reported as completion", async () => {
  const run = setup([security, security]);
  const result = run.driver.read({ command: "claude", atFiveHourLimit: false });
  await vi.advanceTimersByTimeAsync(31_000);
  const report = await result;
  assert.equal(report.result.onboardingCompleted, undefined);
  assert.deepEqual(run.writes, ["\r"]);
});

for (const page of ["Agree to data sharing", "New agreement\nEnter to confirm · Esc to cancel"]) {
  test(`an additional page without the welcome banner receives no keys: ${page}`, async () => {
    const run = setup([theme, page]);
    const result = run.driver.read({ command: "claude", atFiveHourLimit: false });
    await vi.advanceTimersByTimeAsync(8000);
    const report = await result;
    assert.deepEqual(report.result, { kind: "not_attempted", reason: "startup_failed", startup: { screen: "onboarding" } });
    assert.deepEqual(run.writes, ["\r"]);
  });
}
