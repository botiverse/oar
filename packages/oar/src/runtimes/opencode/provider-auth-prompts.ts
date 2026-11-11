import type { ProviderLoginInteraction, ProviderLoginPrompt } from "../../contracts/provider-auth.js";
import { fieldApplies, type OpencodeFormField } from "./provider-auth-registry.js";

/** A `Form.Value` OpenCode accepts in an `answer`. */
export type FormValue = string | number | boolean | readonly string[];

/** Both signals as one, either may be absent. */
export function eitherSignal(first: AbortSignal | undefined, second: AbortSignal | undefined): AbortSignal | undefined {
  if (first === undefined) {
    return second;
  }
  return second === undefined ? first : AbortSignal.any([first, second]);
}

/**
 * Ask the host, rejecting with the signal's reason once it aborts even if the
 * host leaves its prompt pending (Pi's facade does the same).
 */
export async function ask(interaction: ProviderLoginInteraction, prompt: ProviderLoginPrompt): Promise<string> {
  const { signal } = prompt;
  signal?.throwIfAborted();
  if (signal === undefined) {
    return interaction.prompt(prompt);
  }
  const aborted = Promise.withResolvers<never>();
  const abort = (): void => { aborted.reject(signal.reason); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([interaction.prompt(prompt), aborted.promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/**
 * The fields OAR asks: required, visible and applicable given the answers so
 * far. Hidden and optional ones are left to OpenCode, which applies their
 * defaults itself (observed on 2.2.7 for GitLab's instance URL and the
 * OpenCode console's hidden server); `external` fields cannot be answered here.
 */
function asked(entry: OpencodeFormField, answers: Readonly<Record<string, unknown>>): boolean {
  return entry.required && !entry.hidden && entry.type !== "external" && fieldApplies(entry, answers);
}

function defaults(fields: readonly OpencodeFormField[]): Record<string, unknown> {
  return Object.fromEntries(fields.flatMap((entry) => (entry.default === undefined ? [] : [[entry.key, entry.default]])));
}

/** True when the form would ask the person something a bare key cannot answer. */
export function formAsks(fields: readonly OpencodeFormField[]): boolean {
  const known = defaults(fields);
  return fields.some((entry) => asked(entry, known) && entry.default === undefined);
}

function promptFor(entry: OpencodeFormField, signal: AbortSignal | undefined): ProviderLoginPrompt {
  const message = entry.title ?? entry.key;
  const cancellation = signal === undefined ? {} : { signal };
  if (entry.type === "boolean") {
    return { ...cancellation, kind: "select", message, options: [{ id: "true", label: "Yes" }, { id: "false", label: "No" }] };
  }
  if (entry.options.length > 0 && !entry.custom && entry.type !== "multiselect") {
    return { ...cancellation, kind: "select", message, options: entry.options.map((option) => ({ id: option.value, label: option.label })) };
  }
  const fallback = typeof entry.default === "string" ? entry.default : undefined;
  const placeholder = entry.placeholder ?? fallback;
  return { ...cancellation, kind: "text", message, ...(placeholder === undefined ? {} : { placeholder }) };
}

function valueOf(entry: OpencodeFormField, answer: string): FormValue | undefined {
  const trimmed = answer.trim();
  if (trimmed === "") {
    return typeof entry.default === "string" || typeof entry.default === "number" || typeof entry.default === "boolean" ? entry.default : undefined;
  }
  switch (entry.type) {
    case "boolean":
      return trimmed === "true";
    case "number":
    case "integer":
      return Number(trimmed);
    case "multiselect":
      return trimmed.split(",").map((part) => part.trim()).filter((part) => part !== "");
    default:
      return trimmed;
  }
}

/** Ask each applicable required field in OpenCode's order; the answer object holds only what the person gave. */
export async function askForm(
  interaction: ProviderLoginInteraction,
  fields: readonly OpencodeFormField[],
  signal: AbortSignal | undefined,
): Promise<Record<string, FormValue>> {
  const answers: Record<string, FormValue> = {};
  const known = defaults(fields);
  for (const entry of fields) {
    if (!asked(entry, { ...known, ...answers })) {
      continue;
    }
    const value = valueOf(entry, await ask(interaction, promptFor(entry, signal)));
    if (value !== undefined) {
      answers[entry.key] = value;
    }
  }
  return answers;
}
