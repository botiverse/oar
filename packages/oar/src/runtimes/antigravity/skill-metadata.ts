import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { safeLoad, FAILSAFE_SCHEMA, DEFAULT_SAFE_SCHEMA, Schema, Type } from "js-yaml";
import type { SkillEntry } from "../../contracts/inventory.js";
import { asRecord } from "../../shared/json.js";

// yaml.v3 accepts YAML 1.1 boolean spellings for typed bool fields, including flow mappings.
const typedSchema = new Schema({ include: [DEFAULT_SAFE_SCHEMA], implicit: [new Type("tag:yaml.org,2002:bool", {
  kind: "scalar",
  resolve: (value: unknown): boolean => typeof value === "string" && /^(?:true|false|yes|no|on|off|y|n)$/iu.test(value),
  construct: (value: unknown): boolean => typeof value === "string" && /^(?:true|yes|on|y)$/iu.test(value),
})] });

function scalar(value: unknown, typed: unknown): string | undefined {
  if (typed === undefined || typed === null) { return undefined; }
  if (typeof value === "string") { return value.replace(/\n+$/u, ""); }
  throw new TypeError("Invalid skill metadata");
}
export interface FileSkill { readonly item: SkillEntry; readonly hidden: boolean; readonly source: string }

/** agy's YAML struct accepts scalar strings, but rejects quoted booleans in flags. */
export async function antigravitySkillMetadata(path: string, signal: AbortSignal): Promise<FileSkill | null> {
  signal.throwIfAborted();
  try {
    const contents = await readFile(path, { encoding: "utf8", signal });
    const source = contents.trimStart();
    if (!source.startsWith("---\n") && !source.startsWith("---\r\n")) { return null; }
    const end = /\r?\n---(?:\r?\n|$)/u.exec(source.slice(3));
    if (end === null) { return null; }
    const header = source.slice(3, 3 + end.index);
    const parsed: unknown = safeLoad(header, { schema: typedSchema });
    const record = asRecord(parsed);
    if (record === null && parsed !== undefined && parsed !== null) { return null; }
    const data = record ?? {};
    // Go decodes scalar text into string fields without normalizing numbers or dates.
    const text = asRecord(safeLoad(header, { schema: FAILSAFE_SCHEMA })) ?? {};
    const flags = [data["disable-model-invocation"], data["disable-slash-command"]];
    if (flags.some(value => value !== undefined && value !== null && typeof value !== "boolean")) { return null; }
    const declaredName = scalar(text.name, data.name);
    const name = declaredName === undefined || declaredName === "" ? basename(dirname(path)) : declaredName;
    const description = scalar(text.description, data.description);
    return { item: { name, path, ...(description === undefined || description === "" ? {} : { description }), disableModelInvocation: data["disable-model-invocation"] === true }, hidden: data["disable-slash-command"] === true, source: contents };
  } catch { signal.throwIfAborted(); return null; }
}
