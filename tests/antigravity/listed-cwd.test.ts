import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { normalizeAntigravityListedCwd } from "../../packages/oar/src/runtimes/antigravity/session.js";
import { sameDirectory } from "../../packages/oar/src/shared/same-directory.js";

test.each([
  ["%E5%B0%8F%E7%B1%B3", "小米"], ["my%20project", "my project"],
  ["space%2520dir", "space%20dir"], ["%25E5%25B0%258F%25E7%25B1%25B3", "%E5%B0%8F%E7%B1%B3"],
  ["100%25", "100%"], ["a%23b%3Fc%5Bd%5D+e", "a#b?c[d]+e"], ["a+b", "a+b"],
])("Antigravity listed pathname %s decodes once", (listed, decoded) => {
  expect(normalizeAntigravityListedCwd(`/tmp/${listed}`)).toBe(`/tmp/${decoded}`);
});

test.each([
  "a%2fb", "a%00b", "bad%", "%2x", "%ff", "%C3%28", "raw space", "raw小米",
  "raw#", "raw?", "raw[", "raw]", "raw\n", "raw\u007F", "raw\\",
])("an invalid segment %j preserves the entire listed pathname", (segment) => {
  const listed = `/tmp/valid%20first/${segment}`;
  expect(normalizeAntigravityListedCwd(listed)).toBe(listed);
});

test("encoded backslashes follow platform separator rules", () => {
  expect(normalizeAntigravityListedCwd("/a/b%5Cc", "win32")).toBe("/a/b%5Cc");
  expect(normalizeAntigravityListedCwd("/a/b%5Cc", "linux")).toBe(String.raw`/a/b\c`);
});

test.each([["my%20project", "my project"], ["%E5%B0%8F%E7%B1%B3", "小米"]])("Windows URI drive prefix and escaped %s identify the saved directory", (listed, decoded) => {
  const normalized = normalizeAntigravityListedCwd(`/D:/a/${listed}`, "win32");
  expect(sameDirectory(normalized, path.win32.join("D:/a", decoded), "win32")).toBe(true);
  expect(sameDirectory(normalized, path.win32.join("D:/a", listed), "win32")).toBe(false);
});

function expectSavedDirectory(cwd: string, sibling: string): void {
  const alias = `${cwd}-alias`;
  symlinkSync(cwd, alias, process.platform === "win32" ? "junction" : "dir");
  const saved = normalizeAntigravityListedCwd(pathToFileURL(cwd).pathname);
  expect(sameDirectory(saved, cwd)).toBe(true);
  expect(sameDirectory(saved, alias)).toBe(true);
  expect(sameDirectory(saved, sibling)).toBe(false);
}

test("coexisting literal and escaped names keep distinct identities and accept their own aliases", () => {
  const root = mkdtempSync(path.join(tmpdir(), "oar-agy-cwd-"));
  try {
    const original = path.join(root, "小米");
    const literal = path.join(root, encodeURIComponent("小米"));
    mkdirSync(original);
    mkdirSync(literal);
    expectSavedDirectory(original, literal);
    expectSavedDirectory(literal, original);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
