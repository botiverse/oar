# Runtime config form

> **Status: DRAFT** (2026-10-16). Proposed in Raft `#wg-runtime-form:3fb4c626`
> at artin's direction: the agent-creation form moves from the Raft host into
> OAR. Interface shape: HaoHao. Runtime contract review: Huaihuai. Draft and
> Raft integration: archer. Nothing here is built yet.

A host that lets a person create an agent asks the same question for every
runtime: which settings can this runtime take, which values may each have,
and how do the chosen values become the options a session opens with. Today
the Raft host answers it by hand, once per runtime, in its own code. This
spec moves the answer next to the runtime that owns it.

`configForm` describes the settings. A separate pure function turns chosen
values into `SessionOptions`. Both live under `@botiverse/oar/forms`, an entry
that loads no runtime SDK.

## Principles

1. **The runtime that owns a setting describes it.** Adding a runtime or a
   setting is one change in OAR, not one per host.
2. **Presence is the capability** ([capabilities.md](../design/capabilities.md#1-a-whole-operation-is-a-member-that-may-be-absent)).
   A runtime without a form has no `configForm`. A field the form does not
   list is not configurable, whatever `refusedSessionOptions` says: a missing
   refusal is not a grant.
3. **Not enumerated is not none.** A model list that could not be read is a
   status (`unavailable` with a reason), never an empty list, and never a
   reason to clear a value the host already saved.
4. **No guessing.** Where a runtime does not tell OAR what a model supports,
   the form says `unknown` and offers nothing for it; it does not invent
   options that would then be required.
5. **Data and behavior are separate.** `configForm` is plain data a host can
   serialize. Validation and the mapping to `SessionOptions` are pure
   functions beside it.
6. **Storage is the host's.** How a host stores a configuration (Raft's
   versioned `RuntimeConfig`, saved provider connections, credentials) is
   not OAR's. OAR's value shape must keep every distinction a host needs to
   store, so nothing is lost on the way to `SessionOptions`.

## Shape (proposal; HaoHao owns the final types)

```ts
// @botiverse/oar/forms — no runtime SDK, no side effect on import.
export interface RuntimeConfigForm {
  readonly protocol: 1;
  readonly runtime: string;            // the Runtime.id it describes
  readonly fields: readonly ConfigField[];
}

export type ConfigField =
  | ModelField | EffortField | SelectField | SecretField
  | TextField | BooleanField | EnvField;

interface FieldBase {
  readonly id: string;                 // stable; never changes with its copy
  readonly label: { readonly key: string; readonly en: string };
  readonly hint?: { readonly key: string; readonly en: string };
  readonly required: boolean;
  /** Shown only when another field has one of these values. */
  readonly visibleWhen?: { readonly field: string; readonly in: readonly string[] };
}

/** Options from `Runtime.listModels` on the machine that will run the agent. */
interface ModelField extends FieldBase {
  readonly kind: "model";
  /** A model id the list does not name may be typed in. */
  readonly customValue: boolean;
}

/** Options from the chosen model's `ModelEntry.effortLevels`. */
interface EffortField extends FieldBase {
  readonly kind: "effort";
  readonly modelField: string;
}

interface SelectField extends FieldBase {
  readonly kind: "select";
  readonly options: readonly { readonly value: string; readonly label: { readonly key: string; readonly en: string } }[];
}

/** Write-only: a stored value is never read back into the form. */
interface SecretField extends FieldBase { readonly kind: "secret" }
interface TextField extends FieldBase { readonly kind: "text"; readonly format?: "url" }
interface BooleanField extends FieldBase { readonly kind: "boolean" }
interface EnvField extends FieldBase { readonly kind: "env" }
```

### Values

The value shape keeps the distinctions a host must store and a launch must
honor:

```ts
export type ModelValue =
  | { readonly kind: "inherit" }                    // the runtime's default
  | { readonly kind: "preset"; readonly id: string } // a listed model
  | { readonly kind: "custom"; readonly name: string };

export type SecretValue =
  | { readonly kind: "unset" }                      // never provided
  | { readonly kind: "keep" }                       // keep the stored secret
  | { readonly kind: "clear" }                      // remove it
  | { readonly kind: "set"; readonly value: string };

export type ConfigValues = Readonly<Record<string, ModelValue | SecretValue | string | boolean | Readonly<Record<string, string>> | null>>;
```

A runtime that does not support `inherit` today does not gain it in this
migration: the type allows it, the form for that runtime does not offer it.

### Behavior

```ts
export function validateConfig(
  form: RuntimeConfigForm,
  values: ConfigValues,
  models: ModelListing,              // live, fallback, or unavailable (below)
): readonly ConfigIssue[];           // [{ field, code }], codes are stable keys

export function toSessionOptions(
  form: RuntimeConfigForm,
  values: ConfigValues,
): { ok: true; options: Partial<SessionOptions> } | { ok: false; issues: readonly ConfigIssue[] };
```

`ModelListing` carries the status of the list, with the same states the Raft
v2 protocol already renders:

| `listModels` outcome | status | options |
|---|---|---|
| models | `live` | the models |
| unauthenticated, timeout, failure, empty | `unavailable` with a reason | none |
| no live list, a bundled list exists | `fallback` with a reason | the bundled list |

A value saved earlier is valid against `unavailable`: validation does not
reject or clear it because the list could not be read.

## The `forms` entry

- `@botiverse/oar/forms` exports every runtime's `configForm`, `validateConfig`
  and `toSessionOptions`. Runtimes import their form from there, not the
  other way round.
- CI checks that the entry's dependency graph contains no runtime SDK (HaoHao).
- A test imports the entry from an empty consumer and asserts no SDK module
  loads and nothing initializes (Huaihuai).
- If a host must not even install the SDKs, the entry becomes its own light
  package in this repository. Decide when a host needs it.

## Machine capability reporting

*HaoHao fills this section.* Agreed so far: the daemon reports a protocol
version, the `configForm` field ids each runtime explicitly supports on that
machine, and its OAR version (diagnostics only). The host sends only fields in
both its own `configForm` and that report, and checks the report again on
submit and on launch. A daemon that reports nothing keeps the host's current
behavior: it is neither "everything supported" nor "nothing supported". An
unknown capability hides the field; it does not clear a saved value.

## Raft host integration

Stays in Raft: the v2 wire protocol and the web and mobile renderers; saved
provider connections; credential storage; the stored `RuntimeConfig` format;
the frozen v1 forms that installed apps still request.

Moves to OAR: which fields a runtime has, their stable ids, English default
copy and translation keys, where their options come from, validation, and
the mapping to `SessionOptions`.

The Raft server translates a `configForm` into a v2 form definition, fills
the model source from the machine's `listModels` result, applies the machine
capability report, and translates copy by key. It maps `ConfigValues` to and
from its own `RuntimeConfig`. The daemon maps a stored `RuntimeConfig` back to
`ConfigValues` and calls `toSessionOptions` to launch.

## Migration

One runtime per pull request, in this order: **Grok**, then **Codex**, then
**Built-in / Pi** (provider and saved connections are the hardest; a provider
is the authentication axis, not a third selector).

Every migration pull request must show:

1. **No protocol change.** Raft's `packages/runtime-form/fixtures/<runtime>.form.json`
   and `.edit.json` are byte-identical before and after. Any difference is a
   protocol change and goes in its own reviewed pull request.
2. **No behavior change.** Existing stored configurations produce the same
   launch options as before (a table test over real stored shapes), and the
   form offers no option the runtime did not offer before.
3. **Edit, save and launch** of an existing agent round-trip.
4. **Version skew.** Old Computer with the new server, and new Computer with
   the old server.
5. **Failure keeps data.** A failed probe, an empty list and an unknown
   capability never clear a saved value and are never read as "forbidden".

## Prior art and what this refuses

- **OAR #1 "launch-config form surface" (v7, HaoHao, merged 08-10 as
  `8a0fc7dab`)** generated one conditional JSON Schema (`if`/`then` per
  runtime and per model) from runtime descriptors. The 08-21 contract rebuild
  (`e7061fcfb`) removed `src/config/`; no reason was recorded. This draft
  keeps its server-side generation and its unknown-dimension handling, and
  refuses the conditional schema: the Raft v2 protocol already has a generic
  renderer for fields, option sources and dependent selects, so OAR describes
  fields and the host emits the protocol it already serves.
- Decisions carried from `#wg-oar:32cdfc4f`: encapsulate only bounded
  differences (xxchan); unknown capability means no options, not guessed
  required ones; "not enumerated" is a status, never an empty list; a
  provider belongs to the authentication axis.
- **Refused: inferring configurability from `refusedSessionOptions`.** It
  lists what a runtime refuses; it is silent on what a host should offer.
- **Refused: moving storage.** A stored configuration must not change with
  OAR's release cadence.

## Open questions

1. Final type names and where `ModelListing` lives (HaoHao).
2. Whether `env` stays a field kind or remains a host-level setting.
3. Whether the Raft-only `command` override (a custom executable) is a field
   or a constructor setting ([capabilities.md](../design/capabilities.md#a-runtimes-own-settings)).
