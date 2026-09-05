import type { ModelLister } from "../../contracts/list-models.js";

/**
 * Kimi exposes no model listing surface: no CLI subcommand prints the
 * account's models and its wire protocol has no list method. The reason is
 * typed so callers can show it instead of guessing from an empty list.
 */
export const kimiListModels: ModelLister = async () => {
  await Promise.resolve();
  return {
    kind: "unsupported",
    reason: "kimi exposes no model listing surface (no CLI subcommand or wire method)",
  };
};
