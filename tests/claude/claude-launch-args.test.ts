import { expect, test } from "vitest";
import { UnsupportedOptionError } from "../../packages/oar/src/contracts/errors.js";
import { refuseManagedLaunchArgs } from "../../packages/oar/src/runtimes/claude/launch-args.js";

// #336 (Lookout's SDK comparison, claude 2.1.296): `--continue` made claude exit next to OAR's
// `--session-id`, and after `--fork-session` Session.id kept the old id. Refuse such flags up front.
test.each(["--continue", "-c", "--resume", "-r", "--session-id", "--fork-session", "--permission-mode=plan", "--permission-mode", "-p", "--output-format", "--json-schema"])("launchArgs %s is refused", (flag) => {
  expect(() => { refuseManagedLaunchArgs([flag, "value"]); }).toThrow(UnsupportedOptionError);
});

test("other launchArgs pass, and the refusal names the flag and the option to use", () => {
  expect(() => { refuseManagedLaunchArgs(["--tools", "Read,Grep", "--add-dir", "/x", "--max-turns", "2"]); }).not.toThrow();
  expect(() => { refuseManagedLaunchArgs(undefined); }).not.toThrow();
  expect(() => { refuseManagedLaunchArgs(["--resume=abc"]); }).toThrow(/claude launchArgs cannot include --resume: use SessionOptions\.resume/u);
});
