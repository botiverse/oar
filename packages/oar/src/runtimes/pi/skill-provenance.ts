import type { SkillEntry } from "../../contracts/inventory.js";
import { skillScope, textField } from "../../shared/inventory.js";

/** SourceInfo is shared by SDK discovery and get_commands over native RPC. */
export function piSkillProvenance(source: { readonly source: string; readonly scope: string; readonly origin: string }): Pick<SkillEntry, "source" | "scope" | "plugin"> {
  return {
    source: source.source,
    ...skillScope(source.scope, { user: "user", project: "project", temporary: "other" }),
    ...(source.origin === "package" ? textField("plugin", source.source) : {}),
  };
}
