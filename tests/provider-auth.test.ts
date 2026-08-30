import { expect, test } from "vitest";
import { toLoginEvent, toLoginPrompt } from "../packages/oar/src/runtimes/pi/auth.js";

test("device_code and auth_url events surface the login link", () => {
  expect(toLoginEvent({
    type: "device_code",
    userCode: "ABCD-1234",
    verificationUri: "https://example.com/device",
    intervalSeconds: 5,
    expiresInSeconds: 1800,
  })).toEqual({
    kind: "device_code",
    userCode: "ABCD-1234",
    verificationUri: "https://example.com/device",
    intervalSeconds: 5,
    expiresInSeconds: 1800,
  });
  expect(toLoginEvent({ type: "auth_url", url: "https://example.com/oauth" }))
    .toEqual({ kind: "auth_url", url: "https://example.com/oauth" });
});

test("info and progress events collapse to a neutral message", () => {
  expect(toLoginEvent({ type: "info", message: "hello" })).toEqual({ kind: "info", message: "hello" });
  expect(toLoginEvent({ type: "progress", message: "working" })).toEqual({ kind: "info", message: "working" });
});

test("prompts map by type, preserving select options", () => {
  expect(toLoginPrompt({ type: "secret", message: "API key?", placeholder: "sk-…" }))
    .toEqual({ kind: "secret", message: "API key?", placeholder: "sk-…" });
  expect(toLoginPrompt({
    type: "select",
    message: "Pick one",
    options: [{ id: "a", label: "Account" }, { id: "k", label: "API key", description: "metered" }],
  })).toEqual({
    kind: "select",
    message: "Pick one",
    options: [{ id: "a", label: "Account" }, { id: "k", label: "API key", description: "metered" }],
  });
});
