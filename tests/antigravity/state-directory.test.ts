import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { antigravityStateArgs, antigravityUsesDefaultState } from "../../packages/oar/src/runtimes/antigravity/state-directory.js";
import { antigravityAcpProfile } from "../../packages/oar/src/runtimes/antigravity/session.js";

afterEach(() => { vi.unstubAllEnvs(); });

test("an unset or empty GEMINI_HOME preserves the native default", () => {
  for (const env of [{}, { GEMINI_HOME: "" }]) {
    expect(antigravityStateArgs(env)).toEqual([]);
    expect(antigravityUsesDefaultState(env)).toBe(true);
  }
});

test("POSIX compares the requested directory to the effective HOME without changing it", () => {
  const env = { HOME: "/isolated home", GEMINI_HOME: "/isolated home/.gemini/" };
  expect(antigravityStateArgs(env, "linux")).toEqual(["--gemini-dir", "/isolated home/.gemini/"]);
  expect(antigravityUsesDefaultState(env, "linux")).toBe(true);
  expect(antigravityUsesDefaultState({ ...env, GEMINI_HOME: "/different" }, "linux")).toBe(false);
  expect(antigravityUsesDefaultState({ GEMINI_HOME: "/different" }, "linux")).toBe(false);
  expect(antigravityUsesDefaultState({ ...env, GEMINI_HOME: "/ISOLATED HOME/.gemini" }, "linux")).toBe(false);
  expect(env.HOME).toBe("/isolated home");
});

test("Windows uses USERPROFILE and case-insensitive environment names and paths", () => {
  const env = { Home: "C:\\wrong", UserProfile: "C:\\selected", Gemini_Home: "c:/SELECTED/.gemini/" };
  expect(antigravityStateArgs(env, "win32")).toEqual(["--gemini-dir", "c:/SELECTED/.gemini/"]);
  expect(antigravityUsesDefaultState(env, "win32")).toBe(true);
  expect(antigravityUsesDefaultState({ ...env, Gemini_Home: "C:\\wrong\\.gemini" }, "win32")).toBe(false);
  expect(antigravityUsesDefaultState({ HOME: "C:\\selected", GEMINI_HOME: "C:\\selected\\.gemini" }, "win32")).toBe(false);
});

// oxlint-disable-next-line eslint/max-statements -- One environment overlay exercise covers inheritance, override and deletion.
test("session launch selects an inherited or overlaid directory and respects null removal", () => {
  const inherited = path.resolve("inherited profile");
  const overlaid = path.resolve("overlaid profile");
  vi.stubEnv("GEMINI_HOME", inherited);
  const { args } = antigravityAcpProfile;
  expect(typeof args).toBe("function");
  if (typeof args !== "function") { throw new TypeError("Antigravity must resolve its child environment"); }
  expect(args({ cwd: process.cwd() })).toEqual(["acp", "--dangerously-skip-permissions", "--process-per-session", "--gemini-dir", inherited]);
  expect(args({ cwd: process.cwd(), env: { GEMINI_HOME: overlaid } })).toEqual(["acp", "--dangerously-skip-permissions", "--process-per-session", "--gemini-dir", overlaid]);
  expect(args({ cwd: process.cwd(), env: { GEMINI_HOME: null } })).toEqual(["acp", "--dangerously-skip-permissions", "--process-per-session"]);
  expect(process.env.GEMINI_HOME).toBe(inherited);
});
