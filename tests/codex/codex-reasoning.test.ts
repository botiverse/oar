import { describe, expect, test } from "vitest";
import { codexReasoningContent } from "../../packages/oar/src/runtimes/codex/reasoning.js";

describe("codex reasoning projection", () => {
  test("distinguishes readable, encrypted, empty, and unrelated items", () => {
    expect({
      readable: codexReasoningContent({
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Checked the bridge path." }],
        content: [],
        encrypted_content: "opaque-ciphertext",
      }),
      redacted: codexReasoningContent({
        type: "reasoning",
        summary: [],
        encrypted_content: "opaque-ciphertext",
      }),
      empty: codexReasoningContent({
        type: "reasoning",
        summary: [],
        content: [],
        encrypted_content: null,
      }),
      unrelated: codexReasoningContent({ type: "message" }),
    }).toMatchInlineSnapshot(`
      {
        "empty": {
          "kind": "empty",
        },
        "readable": {
          "kind": "text",
          "text": "Checked the bridge path.",
        },
        "redacted": {
          "kind": "redacted",
        },
        "unrelated": null,
      }
    `);
  });
});
