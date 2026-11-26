// Generated from packages/oar/assets/suggested-versions.json by packages/oar/scripts/generate-suggested-versions.mjs.
// Do not edit by hand; update the JSON asset and run `pnpm --filter @botiverse/oar build`.
const bundledSuggestedVersionsRaw: unknown = {
  "schemaVersion": 1,
  "updatedAt": "2026-11-26",
  "runtimes": {
    "codex": {
      "version": "0.166.0",
      "reason": "Supports GPT-6.2 models (gpt-6.2-sol, gpt-6.2-astra)",
      "verifiedAt": "2026-11-26",
      "evidence": "https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json"
    },
    "claude": {
      "version": "2.1.321",
      "reason": "Built-in catalog recognition for Claude Fable 5.2 (claude-fable-5-2)",
      "verifiedAt": "2026-11-26",
      "evidence": "https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21321"
    }
  }
};

export default bundledSuggestedVersionsRaw;
