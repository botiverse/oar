import { expect, test } from "vitest";
import { codexHomePath } from "../../packages/oar/src/runtimes/codex/home-initialization.js";

test("codexHomePath respects USERPROFILE and case-insensitive CODEX_HOME on win32", () => {
  expect(codexHomePath({ USERPROFILE: String.raw`C:\Users\isolated` }, String.raw`C:\work`, "win32")).toBe(String.raw`C:\Users\isolated\.codex`);
  expect(codexHomePath({ userprofile: String.raw`C:\Users\lower` }, String.raw`C:\work`, "win32")).toBe(String.raw`C:\Users\lower\.codex`);
  expect(codexHomePath({ USERPROFILE: String.raw`C:\Users\isolated`, codex_home: String.raw`D:\custom-codex` }, String.raw`C:\work`, "win32")).toBe(String.raw`D:\custom-codex`);
});
