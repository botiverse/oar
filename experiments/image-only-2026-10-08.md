# Image-only inputs, 2026-10-08

OAR accepts empty text when at least one image accompanies it. An exactly
empty string with no images is recorded and rejected `unsupported`, reason
`empty input: give text or images`, before contacting the runtime. This
applies to prompt, steer and queue; whitespace is unchanged.

The adapter boundary and model boundary are different. OAR sends no empty
text block to Claude, Codex or ACP. Their native harnesses can add text of
their own. Removing that native content would change runtime semantics.

## Observations

All provider checks used local scripted models, temporary configuration and
dummy keys. No real account or model quota was used.

| Runtime | Image-only request received by the scripted provider |
|---|---|
| Claude 2.1.293 | Anthropic image block, plus Claude's nonempty system reminder and image-source label. The stdin user message contains only the image. |
| Codex 0.161.0 | Responses `input_image`, surrounded by native `input_text` image delimiters. The app-server input contains only `localImage`. |
| Pi SDK 1.0.4 | Anthropic image block, no text block. OAR passes `""` to the SDK with images; the model must declare image input. |
| Grok 1.0.46 (2765805b9442) | Chat-completions `image_url`, plus native image-file description and query wrapper. |
| Kimi 2.1.1 | Chat-completions `image_url`, no text part, with the model's `image_in` capability enabled. |
| OpenCode 1.18.35 | Anthropic image block, no empty text part. The separate title request adds its own title prompt. The model's `modalities.input` must include `image`. |
| Antigravity 1.3.0 | Gemini `inlineData`, plus a nonempty `USER_REQUEST` wrapper and metadata text. |
| Cursor SDK 1.0.36 | Stand-in SDK confirms `agent.send({text: "", images: [...]})`. Backend handling of empty text remains unverified; no reusable agent RPC backend was available. An image-only steer remains unsupported. |

The initial assertion that every model request must contain no text block
failed for native labels added by Claude and Codex. The final test verifies
image delivery and absence of an **empty** text block; transport unit tests
separately require image-only arrays from OAR itself.

The initial 1×1 PNG also exposed two fixture constraints:

- Grok accepted the prompt and completed the turn but dropped the image
  before the provider request. Its text contained
  `<image_dropped_notice>Image 1 was dropped before send: too small (1×1); images must be at least 8×8 pixels.</image_dropped_notice>`.
  That notice was inside native system-reminder text and no image part
  reached the provider. A 32×32 PNG reached the provider with the same
  adapter and model configuration. OAR does not parse image dimensions.
  The published [normalizer source](https://github.com/xai-org/grok-build/blob/77cd7eb675ba911c225c3aaeeece3a20cbccc426/crates/codegen/xai-grok-shell/src/session/image_normalize.rs#L440)
  has the same minimum-side refusal and also checks a 512-pixel minimum
  area. This source revision is not asserted to match the installed binary.
- OpenCode's text-only model fixture substituted a “Cannot read” notice.
  Declaring image input on the fixture model enabled delivery.

## Reproduce

The shared native regression is
[`sea-trial/vendor/image-only.vendor.test.ts`](../sea-trial/vendor/image-only.vendor.test.ts).
Install the corresponding real CLI, set its `OAR_<RUNTIME>_BIN` override
when it is not on PATH, then run one provider at a time:

```sh
OAR_TEST=claude-aimock pnpm exec vitest run sea-trial/vendor/image-only.vendor.test.ts
OAR_TEST=codex-aimock pnpm exec vitest run sea-trial/vendor/image-only.vendor.test.ts
OAR_TEST=pi-aimock pnpm exec vitest run sea-trial/vendor/image-only.vendor.test.ts
OAR_TEST=grok-aimock pnpm exec vitest run sea-trial/vendor/image-only.vendor.test.ts
OAR_TEST=kimi-aimock pnpm exec vitest run sea-trial/vendor/image-only.vendor.test.ts
OAR_TEST=opencode-aimock pnpm exec vitest run sea-trial/vendor/image-only.vendor.test.ts
OAR_TEST=antigravity-aimock pnpm exec vitest run sea-trial/vendor/image-only.vendor.test.ts
```

All seven checks passed. The shared behavior case also covers empty-control
refusal and preservation of image paths and empty input in the request.
Unit tests cover the common kernel, the independent Codex RPC path, Claude
stdin, ACP blocks and Cursor SDK arguments.
