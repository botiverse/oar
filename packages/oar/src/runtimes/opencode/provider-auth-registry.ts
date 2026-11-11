import type { LoginProvider, LoginProviderMethod, ProviderAuthStatus, ProviderLoginMethod } from "../../contracts/provider-auth.js";
import { asRecord, asRecordList, type JsonRecord } from "../../shared/json.js";

/*
 * OpenCode 2's integration registry (`GET /api/integration`, operation
 * `integration.list`, observed on 2.2.7) projected onto the provider-auth
 * contract. Everything here is pure: the facade feeds it parsed JSON.
 */

export interface OpencodeFormOption {
  readonly value: string;
  readonly label: string;
}

/** One `Form.Field`, reduced to what a prompt needs. */
export interface OpencodeFormField {
  readonly key: string;
  readonly type: string;
  readonly title?: string;
  readonly required: boolean;
  readonly hidden: boolean;
  readonly custom: boolean;
  readonly placeholder?: string;
  readonly default?: unknown;
  readonly options: readonly OpencodeFormOption[];
  readonly when: readonly { readonly key: string; readonly op: string; readonly value: unknown }[];
}

export type OpencodeMethod =
  | { readonly type: "oauth"; readonly id: string; readonly label?: string; readonly form: readonly OpencodeFormField[] }
  | { readonly type: "key"; readonly label?: string; readonly form: readonly OpencodeFormField[] }
  | { readonly type: "env"; readonly names: readonly string[] }
  /** `external` and `command`: OpenCode reads a credential another tool keeps; OAR offers no flow for them. */
  | { readonly type: "other"; readonly native: string };

/** A stored credential (`Connection.CredentialInfo`) or an environment variable OpenCode found (`Connection.EnvInfo`). No secret is in either. */
export type OpencodeConnection =
  | { readonly type: "credential"; readonly id: string; readonly label?: string; readonly method?: string }
  | { readonly type: "env"; readonly name: string };

export interface OpencodeIntegration {
  readonly id: string;
  readonly name: string;
  readonly methods: readonly OpencodeMethod[];
  readonly connections: readonly OpencodeConnection[];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function field(record: JsonRecord): OpencodeFormField | undefined {
  const key = text(record.key);
  const type = text(record.type);
  if (key === undefined || type === undefined) {
    return undefined;
  }
  const title = text(record.title);
  const placeholder = text(record.placeholder);
  const options = asRecordList(record.options).flatMap((option) => {
    const value = text(option.value);
    return value === undefined ? [] : [{ value, label: text(option.label) ?? value }];
  });
  const when = asRecordList(record.when).flatMap((condition) => {
    const whenKey = text(condition.key);
    return whenKey === undefined ? [] : [{ key: whenKey, op: text(condition.op) ?? "eq", value: condition.value }];
  });
  return {
    key,
    type,
    required: record.required === true,
    hidden: record.hidden === true,
    custom: record.custom === true,
    options,
    when,
    ...(title === undefined ? {} : { title }),
    ...(placeholder === undefined ? {} : { placeholder }),
    ...(record.default === undefined ? {} : { default: record.default }),
  };
}

function form(value: unknown): OpencodeFormField[] {
  return asRecordList(value).flatMap((entry) => field(entry) ?? []);
}

function method(record: JsonRecord): OpencodeMethod | undefined {
  const label = text(record.label);
  const labelled = label === undefined ? {} : { label };
  switch (record.type) {
    case "oauth": {
      const id = text(record.id);
      return id === undefined ? undefined : { type: "oauth", id, ...labelled, form: form(record.form) };
    }
    case "key":
      return { type: "key", ...labelled, form: form(record.form) };
    case "env": {
      const names = Array.isArray(record.names) ? record.names.filter((name): name is string => typeof name === "string") : [];
      return names.length === 0 ? undefined : { type: "env", names };
    }
    default:
      return typeof record.type === "string" ? { type: "other", native: record.type } : undefined;
  }
}

function connection(record: JsonRecord): OpencodeConnection | undefined {
  if (record.type === "credential") {
    const id = text(record.id);
    const label = text(record.label);
    const native = text(record.method);
    return id === undefined ? undefined : {
      type: "credential",
      id,
      ...(label === undefined ? {} : { label }),
      ...(native === undefined ? {} : { method: native }),
    };
  }
  const name = text(record.name);
  return record.type === "env" && name !== undefined ? { type: "env", name } : undefined;
}

/** One `Integration.Info`; undefined when it lacks an id. */
export function parseIntegration(value: unknown): OpencodeIntegration | undefined {
  const record = asRecord(value);
  const id = text(record?.id);
  if (record === null || id === undefined) {
    return undefined;
  }
  return {
    id,
    name: text(record.name) ?? id,
    methods: asRecordList(record.methods).flatMap((entry) => method(entry) ?? []),
    connections: asRecordList(record.connections).flatMap((entry) => connection(entry) ?? []),
  };
}

/** `integration.list`'s `data`, in OpenCode's order. */
export function parseIntegrations(body: unknown): OpencodeIntegration[] {
  const data: unknown = asRecord(body)?.data;
  return Array.isArray(data) ? data.flatMap((entry: unknown) => parseIntegration(entry) ?? []) : [];
}

/**
 * The ways OpenCode offers to sign in to one integration: each `oauth`
 * method under its own label (OpenCode 2.2.7 marks no method as a
 * subscription, so none is claimed), then its `key` prompt, then its `env`
 * variables as an ambient key. `external` and `command` methods read a
 * credential another tool keeps and are omitted.
 */
export function loginProviderOf(integration: OpencodeIntegration): LoginProvider | undefined {
  const oauth: LoginProviderMethod[] = [];
  const keys: LoginProviderMethod[] = [];
  for (const entry of integration.methods) {
    if (entry.type === "oauth") {
      oauth.push({ method: "oauth", name: entry.label ?? entry.id, subscription: false });
    } else if (entry.type === "key") {
      keys.push({ method: "api_key", name: entry.label ?? `${integration.name} API key` });
    } else if (entry.type === "env") {
      keys.push({ method: "api_key", name: entry.names.join(", "), ambient: true });
    }
  }
  const methods = [...oauth, ...keys];
  return methods.length === 0 ? undefined : { providerId: integration.id, name: integration.name, methods };
}

/**
 * Status from OpenCode's connections, never a secret: a stored credential
 * first (OpenCode lists the newest first), else an environment variable it
 * found. An `external` credential is configured with no contract method.
 */
export function statusOf(providerId: string, connections: readonly OpencodeConnection[]): ProviderAuthStatus {
  const chosen = connections.find((entry) => entry.type === "credential") ?? connections[0];
  if (chosen === undefined) {
    return { providerId, configured: false };
  }
  if (chosen.type === "env") {
    return { providerId, configured: true, method: "api_key", label: chosen.name };
  }
  const methods: Readonly<Record<string, ProviderLoginMethod>> = { oauth: "oauth", key: "api_key" };
  const kind = chosen.method === undefined ? undefined : methods[chosen.method];
  return {
    providerId,
    configured: true,
    ...(kind === undefined ? {} : { method: kind }),
    ...(chosen.label === undefined ? {} : { label: chosen.label }),
  };
}

/** The user code in an attempt's instructions: `Enter code: X` (GitHub Copilot, OpenAI) or `... and enter code: X` (xAI). */
export function deviceCodeOf(instructions: string): string | undefined {
  return /\benter code:\s*(\S+)\s*$/iu.exec(instructions)?.[1];
}

/** A field applies when every `when` condition holds against the answers so far. */
export function fieldApplies(entry: OpencodeFormField, answers: Readonly<Record<string, unknown>>): boolean {
  return entry.when.every((condition) => {
    const equal = answers[condition.key] === condition.value;
    return condition.op === "neq" ? !equal : equal;
  });
}
