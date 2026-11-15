import { expect, test } from "vitest";
import { ModelConfirmationError } from "../packages/oar/src/index.js";
import { ModelConfirmationError as BrowserModelConfirmationError } from "../packages/oar/src/browser.js";
import { sessionCredentialRedactor } from "../packages/oar/src/shared/credential-redactor.js";
import { appendCleanupFailure } from "../packages/oar/src/shared/executable/process-cleanup-diagnostics.js";

test("the root and portable entries expose the same model-confirmation class", () => {
  expect(BrowserModelConfirmationError).toBe(ModelConfirmationError);
});

test("redaction and cleanup diagnostics preserve the typed refusal without exposing any field or cause", () => {
  const secret = "fixture-private-model-key";
  const clean = sessionCredentialRedactor({ env: { API_KEY: secret } }).redactValue;
  const original = new ModelConfirmationError(`cannot confirm ${secret}`, {
    requested: secret, reported: `reported-${secret}`, catalogSelectorIds: [secret], cause: new Error(secret),
  });
  const redacted = clean(appendCleanupFailure(original, "cleanup incomplete"));
  expect(redacted).toBeInstanceOf(ModelConfirmationError);
  expect(redacted).toMatchObject({ name: "ModelConfirmationError", requested: "[redacted]", reported: "reported-[redacted]",
    catalogSelectorIds: ["[redacted]"], message: "cannot confirm [redacted]; cleanup incomplete", cause: { message: "[redacted]" } });
  expect(JSON.stringify(redacted)).not.toContain(secret);
  expect(original.requested).toBe(secret);
});
