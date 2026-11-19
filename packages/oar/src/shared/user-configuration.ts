import { asRecord } from "./json.js";
import { UnsupportedOptionError } from "../contracts/errors.js";
import type { SessionOptions, UserConfigurationCategory } from "../contracts/session.js";

export const userConfigurationCategories: readonly UserConfigurationCategory[] = ["settings", "mcp", "instructions"];

/** Normalize both spellings before checking a runtime's refusal or building its native options. */
export function configurationExclusions(value: SessionOptions["userConfiguration"]): ReadonlySet<UserConfigurationCategory> {
  if (value === undefined || value === "include") { return new Set(); }
  if (value === "exclude") { return new Set(userConfigurationCategories); }
  const exclude = asRecord(value)?.exclude;
  const validCategory = (category: unknown): category is UserConfigurationCategory => userConfigurationCategories.some(name => name === category);
  if (!Array.isArray(exclude) || !exclude.every((category: unknown) => validCategory(category))) {
    throw new UnsupportedOptionError("userConfiguration", "exclude must contain only settings, mcp or instructions");
  }
  return new Set(exclude);
}
