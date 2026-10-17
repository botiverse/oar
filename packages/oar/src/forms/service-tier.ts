import type { ModelEntry } from "../contracts/list-models.js";

/** `SessionOptions.serviceTier`'s explicit opt-out: no special tier. Not a catalog entry. */
const OPT_OUT = "default";

export interface ServiceTierChoices {
  /**
   * What a host offers and `validateConfig` accepts: the opt-out `default`
   * first, then the model's own tiers. Empty when the model lists no tier or
   * is not enumerated: nothing is offered, not even the opt-out.
   */
  readonly values: readonly string[];
  /**
   * What runs when nothing is chosen, as the listing says
   * (`ModelEntry.defaultServiceTier`), when it is one of `values`; absent when
   * the listing does not say. A host words unset with it ("Default (Priority)").
   */
  readonly whenUnset?: string;
}

/** The service tiers a model offers (docs/spec/config-form.md, "Service tier"). */
export function serviceTierChoices(model: ModelEntry | undefined): ServiceTierChoices {
  const special = (model?.serviceTiers ?? []).filter((tier) => tier !== OPT_OUT);
  if (special.length === 0) {
    return { values: [] };
  }
  const values = [OPT_OUT, ...new Set(special)];
  const whenUnset = model?.defaultServiceTier;
  return whenUnset !== undefined && values.includes(whenUnset) ? { values, whenUnset } : { values };
}
