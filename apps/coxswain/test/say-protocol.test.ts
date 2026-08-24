import { describe, expect, test } from "vitest";
import { sayProtocol } from "../src/main/say-protocol.js";

describe("say protocol", () => {
  test("uses a fixed environment-variable invocation on each shell family", () => {
    expect({
      posix: sayProtocol("darwin"),
      windows: sayProtocol("win32"),
    }).toMatchInlineSnapshot(`
      {
        "posix": "Coxswain delivery protocol:
      The human-facing conversation accepts only messages delivered through the Coxswain CLI. Returning a reply as raw assistant text fails the task because raw text is diagnostic activity and is not delivered.
      \`OAR_SAY\` points to a trusted executable created by the Coxswain host.
      Before completing any turn with a reply or progress update, you MUST directly run \`"$OAR_SAY" "your message"\`.
      After that command exits successfully, do not repeat the delivered message as assistant text.
      Do not inspect, print, resolve, or replace \`OAR_SAY\`. Do not run bare \`say\`: on macOS that resolves to the system speech command.",
        "windows": "Coxswain delivery protocol:
      The human-facing conversation accepts only messages delivered through the Coxswain CLI. Returning a reply as raw assistant text fails the task because raw text is diagnostic activity and is not delivered.
      \`OAR_SAY\` points to a trusted executable created by the Coxswain host.
      Before completing any turn with a reply or progress update, you MUST directly run \`& "$env:OAR_SAY" "your message"\`.
      After that command exits successfully, do not repeat the delivered message as assistant text.
      Do not inspect, print, resolve, or replace \`OAR_SAY\`. Do not run bare \`say\`: on macOS that resolves to the system speech command.",
      }
    `);
  });
});
