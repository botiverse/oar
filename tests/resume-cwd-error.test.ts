import { expect, test } from "vitest";
import { ResumeCwdError, UnsupportedOptionError } from "../packages/oar/src/index.js";
import { ResumeCwdError as BrowserResumeCwdError } from "../packages/oar/src/browser.js";
import { sessionCredentialRedactor } from "../packages/oar/src/shared/credential-redactor.js";
import { appendCleanupFailure } from "../packages/oar/src/shared/executable/process-cleanup-diagnostics.js";

test("root and portable entries share the resume-cwd class and its existing base", () => {
  expect(BrowserResumeCwdError).toBe(ResumeCwdError);
  const error = new ResumeCwdError("original message", { sessionId: "saved", requestedCwd: "/requested", reason: "not_listed" });
  expect(error).toBeInstanceOf(UnsupportedOptionError);
  expect(error).not.toHaveProperty("savedCwd");
  expect(error.message).toBe("original message");
  // Hosts that match on `name` (serialized errors) keep recognizing the refusal.
  expect(error.name).toBe("UnsupportedOptionError");
});

test("redaction and cleanup preserve the refusal type and protect each path and id", () => {
  const secret = "fixture-private-cwd-key";
  const original = new ResumeCwdError(`cannot resume ${secret}`, {
    sessionId: secret, requestedCwd: `/requested/${secret}`, reason: "other_cwd", savedCwd: `/saved/${secret}`,
  });
  const clean = sessionCredentialRedactor({ env: { API_KEY: secret } }).redactValue;
  const redacted = clean(appendCleanupFailure(original, "cleanup incomplete"));
  expect(redacted).toBeInstanceOf(ResumeCwdError);
  expect(redacted).toBeInstanceOf(UnsupportedOptionError);
  expect(redacted).toMatchObject({ name: "UnsupportedOptionError", option: "cwd", sessionId: "[redacted]", reason: "other_cwd",
    requestedCwd: "/requested/[redacted]", savedCwd: "/saved/[redacted]", message: "cannot resume [redacted]; cleanup incomplete" });
  expect(JSON.stringify(redacted)).not.toContain(secret);
  expect(original.sessionId).toBe(secret);
});
