/**
 * Narrow JSON Schema profile: ONE constant for emitter ratchet + fail-closed checker.
 * Dual allow-lists would recreate the schema/validator drift class.
 */

export const PROFILE_KEYWORDS = {
  object: ["type", "properties", "required", "allOf", "additionalProperties"] as const,
  cond: ["if", "then"] as const,
  leaf: ["type", "enum", "const"] as const,
  /** `false` as a whole schema = property FORBIDDEN (auth ambient: credential: false). */
  literalFalseSchema: true,
  /** runtime → model conditional nesting. */
  maxDepth: 2,
} as const;

export interface JsonSchemaObject {
  readonly type?: "object" | "string" | "boolean";
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly allOf?: readonly { readonly if: JsonSchema; readonly then: JsonSchema }[];
  /** true = allow any; object schema = per-value constraint (env strings). */
  readonly additionalProperties?: boolean | JsonSchemaObject;
  readonly enum?: readonly (string | number | boolean)[];
  readonly const?: string | number | boolean;
}

/** Minimal JSON Schema subset we emit. `false` forbids a property. */
export type JsonSchema = false | JsonSchemaObject;

export interface EffectiveSchema {
  readonly properties: Readonly<Record<string, JsonSchema>>;
  readonly required: readonly string[];
}

const ALLOWED_KEYS = new Set<string>([
  ...PROFILE_KEYWORDS.object,
  ...PROFILE_KEYWORDS.cond,
  ...PROFILE_KEYWORDS.leaf,
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isEnumable(v: unknown): v is string | number | boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/** Progressive disclosure for the current value (shared with clients). */
export function effectiveSchema(schema: JsonSchema, value: Record<string, unknown>): EffectiveSchema {
  if (schema === false) {
    return { properties: {}, required: [] };
  }
  const props: Record<string, JsonSchema> = { ...(schema.properties ?? {}) };
  const required = new Set<string>(schema.required ?? []);
  for (const branch of schema.allOf ?? []) {
    if (matches(branch.if, value)) {
      const sub = effectiveSchema(branch.then, value);
      Object.assign(props, sub.properties);
      for (const r of sub.required) {
        required.add(r);
      }
    }
  }
  return { properties: props, required: [...required] };
}

export function matches(ifSchema: JsonSchema, value: Record<string, unknown>): boolean {
  if (ifSchema === false) {
    return false;
  }
  for (const key of ifSchema.required ?? []) {
    if (!(key in value)) {
      return false;
    }
  }
  for (const [k, c] of Object.entries(ifSchema.properties ?? {})) {
    if (!(k in value)) {
      return false;
    }
    if (c !== false) {
      if ("const" in c && value[k] !== c.const) {
        return false;
      }
      if (c.enum !== undefined) {
        if (!isEnumable(value[k]) || !c.enum.includes(value[k])) {
          return false;
        }
      }
    }
  }
  return true;
}

interface Violation {
  path: string;
  keyword: string;
}

interface WalkState {
  path: string;
  depth: number;
  out: Violation[];
}

export function profileViolations(schema: JsonSchema): readonly Violation[] {
  const state: WalkState = { path: "$", depth: 0, out: [] };
  collectViolations(schema, state);
  return state.out;
}

function collectViolations(schema: JsonSchema, state: WalkState): void {
  if (schema === false) {
    return;
  }
  if (state.depth > PROFILE_KEYWORDS.maxDepth) {
    state.out.push({ path: state.path, keyword: `depth>${PROFILE_KEYWORDS.maxDepth}` });
  }
  for (const key of Object.keys(schema)) {
    if (!ALLOWED_KEYS.has(key)) {
      state.out.push({ path: state.path, keyword: key });
    }
  }
  walkProperties(schema, state);
  walkAllOf(schema, state);
  walkAdditional(schema, state);
}

function walkProperties(schema: JsonSchemaObject, state: WalkState): void {
  if (schema.properties === undefined) {
    return;
  }
  for (const [k, sub] of Object.entries(schema.properties)) {
    collectViolations(sub, {
      path: `${state.path}.properties.${k}`,
      depth: state.depth,
      out: state.out,
    });
  }
}

function walkAllOf(schema: JsonSchemaObject, state: WalkState): void {
  if (schema.allOf === undefined) {
    return;
  }
  for (const [i, branch] of schema.allOf.entries()) {
    collectViolations(branch.if, {
      path: `${state.path}.allOf[${String(i)}].if`,
      depth: state.depth,
      out: state.out,
    });
    collectViolations(branch.then, {
      path: `${state.path}.allOf[${String(i)}].then`,
      depth: state.depth + 1,
      out: state.out,
    });
  }
}

function walkAdditional(schema: JsonSchemaObject, state: WalkState): void {
  const additional = schema.additionalProperties;
  if (additional !== undefined && additional !== true && additional !== false) {
    collectViolations(additional, {
      path: `${state.path}.additionalProperties`,
      depth: state.depth,
      out: state.out,
    });
  }
}

export function assertInProfile(schema: JsonSchema): void {
  const first = profileViolations(schema).at(0);
  if (first !== undefined) {
    throw new ProfileError({
      code: "out_of_profile",
      keyword: first.keyword,
      path: first.path,
    });
  }
}

export class ProfileError extends Error {
  readonly code = "out_of_profile" as const;
  readonly keyword: string;
  readonly path?: string;
  constructor(opts: { code: "out_of_profile"; keyword: string; path?: string }) {
    const pathSuffix =
      opts.path !== undefined && opts.path !== "" ? ` at ${opts.path}` : "";
    super(`out_of_profile: ${opts.keyword}${pathSuffix}`);
    this.name = "ProfileError";
    this.keyword = opts.keyword;
    if (opts.path !== undefined) {
      this.path = opts.path;
    }
  }
}

export type ConfigCheckCode =
  | "missing_required"
  | "unsupported_option"
  | "value_not_allowed"
  | "malformed";

export class ConfigCheckError extends Error {
  readonly code: ConfigCheckCode;
  readonly field?: string;
  constructor(opts: { code: ConfigCheckCode; field?: string }) {
    const msg = opts.field === undefined ? opts.code : `${opts.code}: ${opts.field}`;
    super(msg);
    this.name = "ConfigCheckError";
    this.code = opts.code;
    if (opts.field !== undefined) {
      this.field = opts.field;
    }
  }
}

function fieldOpts(fieldPrefix: string): { field: string } | Record<string, never> {
  if (fieldPrefix === "") {
    return {};
  }
  return { field: fieldPrefix };
}

/**
 * Fail-closed: out-of-profile schemas reject; then value is checked against effectiveSchema.
 */
export function checkAgainstProfile(
  schema: JsonSchema,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const first = profileViolations(schema).at(0);
  if (first !== undefined) {
    throw new ProfileError({
      code: "out_of_profile",
      keyword: first.keyword,
      path: first.path,
    });
  }
  checkObject(schema, value, "");
  return value;
}

function checkObject(schema: JsonSchema, value: unknown, fieldPrefix: string): void {
  if (schema === false) {
    throw new ConfigCheckError({ code: "unsupported_option", ...fieldOpts(fieldPrefix) });
  }
  if (!isPlainObject(value)) {
    throw new ConfigCheckError({ code: "malformed", ...fieldOpts(fieldPrefix) });
  }
  rejectForbiddenKeys(schema, value, fieldPrefix);
  requireKeys(schema, value, fieldPrefix);
  for (const [k, v] of Object.entries(value)) {
    checkOneKey({ schema, value, k, v, fieldPrefix });
  }
}

function rejectForbiddenKeys(
  schema: JsonSchemaObject,
  value: Record<string, unknown>,
  fieldPrefix: string,
): void {
  for (const [k, sub] of Object.entries(schema.properties ?? {})) {
    if (sub === false && k in value) {
      const field = fieldPrefix === "" ? k : `${fieldPrefix}.${k}`;
      throw new ConfigCheckError({ code: "unsupported_option", field });
    }
  }
}

function requireKeys(
  schema: JsonSchemaObject,
  value: Record<string, unknown>,
  fieldPrefix: string,
): void {
  const eff = effectiveSchema(schema, value);
  for (const r of eff.required) {
    if (!(r in value)) {
      const field = fieldPrefix === "" ? r : `${fieldPrefix}.${r}`;
      throw new ConfigCheckError({ code: "missing_required", field });
    }
  }
}

interface KeyCheck {
  schema: JsonSchemaObject;
  value: Record<string, unknown>;
  k: string;
  v: unknown;
  fieldPrefix: string;
}

function checkOneKey(ctx: KeyCheck): void {
  const { schema, value, k, v, fieldPrefix } = ctx;
  const field = fieldPrefix === "" ? k : `${fieldPrefix}.${k}`;
  const eff = effectiveSchema(schema, value);
  const p = eff.properties[k];
  if (p === undefined) {
    checkAdditional(schema, v, field);
    return;
  }
  if (p === false) {
    throw new ConfigCheckError({ code: "unsupported_option", field });
  }
  if (p.type === "object" || p.properties !== undefined || p.allOf !== undefined || p.required !== undefined) {
    checkObject(p, v, field);
    return;
  }
  checkLeaf(p, v, field);
}

function checkAdditional(schema: JsonSchemaObject, v: unknown, field: string): void {
  const ap = schema.additionalProperties;
  if (ap === true) {
    return;
  }
  if (ap === undefined || ap === false) {
    throw new ConfigCheckError({ code: "unsupported_option", field });
  }
  checkLeaf(ap, v, field);
}

function checkLeaf(p: JsonSchema, v: unknown, field: string): void {
  if (p === false) {
    throw new ConfigCheckError({ code: "unsupported_option", field });
  }
  if (p.enum !== undefined) {
    if (!isEnumable(v) || !p.enum.includes(v)) {
      throw new ConfigCheckError({ code: "value_not_allowed", field });
    }
    return;
  }
  if (p.const !== undefined) {
    if (v !== p.const) {
      throw new ConfigCheckError({ code: "value_not_allowed", field });
    }
    return;
  }
  if (p.type === "boolean") {
    if (typeof v !== "boolean") {
      throw new ConfigCheckError({ code: "value_not_allowed", field });
    }
    return;
  }
  if (p.type === "string") {
    if (typeof v !== "string") {
      throw new ConfigCheckError({ code: "malformed", field });
    }
    return;
  }
  if (p.type === "object" || p.properties !== undefined || p.allOf !== undefined) {
    checkObject(p, v, field);
  }
}
