import assert from "node:assert/strict";
import { expect, test } from "vitest";
import { LoginSecrets, loginExecutable, stripTerminalEscapes } from "../../packages/oar/src/shared/login.js";

const ESC = "\u001B";
const BEL = "\u0007";

test("terminal escapes go, the visible text of a hyperlink stays", () => {
  const url = "https://example.com/sign-in?state=abc";
  const printed = [
    `${ESC}[1m${ESC}[32mvisit:${ESC}[0m `,
    `${ESC}]8;;${url}${BEL}${url}${ESC}]8;;${BEL}`,
    ` ${ESC}]8;;${url}${ESC}\\here${ESC}]8;;${ESC}\\`,
    `${ESC}]0;window title${BEL}${ESC}[2K${ESC}=${ESC}(Bdone`,
  ].join("");
  assert.equal(stripTerminalEscapes(printed), `visit: ${url} heredone`);
});

test("redaction removes pasted values and token shapes, longest first, and bounds the length", () => {
  const secrets = new LoginSecrets();
  secrets.add("pasted-authorization-code#state");
  secrets.add("pasted-authorization-code");
  secrets.add("#");
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";
  expect(secrets.redact(`code pasted-authorization-code#state, again pasted-authorization-code; key sk-ant-oat01-abcdefghijklmnopqrstuvwxyz; jwt ${jwt}; #`))
    .toMatchInlineSnapshot(`"code [redacted], again [redacted]; key [redacted]; jwt [redacted]; #"`);
  assert.equal(secrets.redact("x".repeat(600)).length, 503);
  assert.equal(secrets.line("\n  fatal: pasted-authorization-code rejected\nat stack frame\n"), "fatal: [redacted] rejected");
});

test("a bundled runtime has no login to drive, and an unreadable version is tried", () => {
  assert.deepEqual(loginExecutable({ kind: "available", via: "bundled" }, "pi", "1.0.0"), {
    kind: "settled",
    result: { kind: "unsupported", reason: "unsupported_installation", detail: "not a machine-installed executable" },
  });
  // An executable that is there, on every platform: this Node.
  const command = process.execPath;
  assert.equal(loginExecutable({ kind: "available", via: "executable", command }, "fake", "1.0.0").kind, "executable");
  assert.equal(loginExecutable({ kind: "available", via: "executable", command, version: "fake 1.0.0" }, "fake", "1.0.0").kind, "executable");
});
