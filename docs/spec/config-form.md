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
  | TextField | BooleanField;

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
  /**
   * The selections this runtime accepts, declared, not implied: `inherit`
   * (the runtime's default), `preset` (a listed model), `custom` (a typed id).
   * Validation and mapping reject a value whose mode is not listed; hiding it
   * in the UI is not enough.
   */
  readonly modes: readonly ("inherit" | "preset" | "custom")[];
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
```

### Values

The value shape keeps the distinctions a host must store and a launch must
honor:

```ts
export type ModelValue =
  | { readonly kind: "inherit" }                    // the runtime's default
  | { readonly kind: "preset"; readonly id: string } // a listed model
  | { readonly kind: "custom"; readonly name: string };

/** What the form submits for a secret field: an edit, not a credential. */
export type SecretEdit =
  | { readonly kind: "unset" }                      // never provided
  | { readonly kind: "keep" }                       // keep the stored secret
  | { readonly kind: "clear" }                      // remove it
  | { readonly kind: "set"; readonly value: string };

export type FormValues = Readonly<Record<string, ModelValue | SecretEdit | string | boolean | null>>;
```

A runtime gains no selection mode in this migration: its `ModelField.modes`
lists exactly what its form accepts today.

### Hidden fields

A field whose `visibleWhen` is not met is **hidden**. A hidden field's value
is neither validated for presence nor passed to `toSessionOptions`; a stale
value under it cannot reach a launch. A host may keep it in storage (so
switching back restores it), but stored is not authorized: only visible
fields launch.

### Model listing

```ts
export type ModelListing =
  | { readonly status: "live"; readonly models: readonly ModelEntry[] }
  | { readonly status: "fallback"; readonly source: "bundled"; readonly reason: ListingReason; readonly models: readonly ModelEntry[] }
  | { readonly status: "unavailable"; readonly reason: ListingReason };

export type ListingReason =
  | "unauthenticated" | "timeout" | "failed" | "empty" | "machine_offline";
```

| `listModels` outcome | status | options |
|---|---|---|
| models | `live` | the models |
| unauthenticated, timeout, failure, empty, offline, and a bundled list exists | `fallback`, `source: "bundled"`, the reason | the bundled list |
| the same, no bundled list | `unavailable`, the reason | none |

A `fallback` always carries its reason and source, so an authentication
failure is never shown as a live list. `ModelListing` is a shared, SDK-free
type in the `forms` entry; acquiring it (calling `listModels` on a machine) is
separate and runtime-side.

### Validation

```ts
export interface ValidationContext {
  readonly mode: "create" | "edit";
  /** The values stored before this edit (edit only), as the host has them. */
  readonly stored?: FormValues;
  readonly models: ModelListing;
}

export function validateConfig(
  form: RuntimeConfigForm,
  values: FormValues,
  context: ValidationContext,
): readonly ConfigIssue[];           // [{ field, code }], codes are stable keys
```

Two questions are kept apart:

- **Preservation.** On `edit`, a `preset` model equal to the stored one is not
  rejected because it is missing from a `fallback` or `unavailable` listing:
  "not enumerated" is never a reason to reject or clear what was stored. On
  `create` there is nothing stored, so a `preset` must be in the listing.
- **Launch validity.** Everything else still applies to every value, stored
  or new: its shape, a declared model mode, a declared option of a select, the
  runtime's explicit capability on that machine, and known constraints such
  as an authentication mode. An unavailable listing only lifts the
  list-membership check.

### Launch mapping

A secret edit is not a credential. The host applies the edit to the
credential it stores (`set` replaces, `clear` removes, `keep` and `unset`
leave it), and at the launch boundary resolves what the agent launches with.
Only resolved values reach the pure mapping:

```ts
export type ResolvedSecret =
  | { readonly present: true; readonly value: string }
  | { readonly present: false };

export type LaunchValues = Readonly<Record<string, ModelValue | ResolvedSecret | string | boolean | null>>;

export function toSessionOptions(
  form: RuntimeConfigForm,
  values: LaunchValues,
): { ok: true; options: Partial<SessionOptions> } | { ok: false; issues: readonly ConfigIssue[] };
```

A required secret that resolves to `present: false` is the issue
`secret_missing`; it is never mapped to an empty or omitted option. Resolved
secrets go only into the launch; they are never returned to a form client.

## The `forms` entry

- `@botiverse/oar/forms` exports every runtime's `configForm`, the shared
  types (`ModelListing` included), `validateConfig` and `toSessionOptions`.
  Runtimes import their form from there, not the other way round.
- CI checks that the entry's dependency graph contains no runtime SDK (HaoHao).
- A test imports the entry from an empty consumer and asserts no SDK module
  loads and nothing initializes. It ships with the implementation pull
  request; Huaihuai verifies it independently.
- If a host must not even install the SDKs, the entry becomes its own light
  package in this repository. Decide when a host needs it.

## Machine capability reporting

The host and every machine pin their own OAR. A form built from the host's
`configForm` can name a field, or a select value, that the machine's OAR does
not know; launching with it would fail, or worse, the value would be dropped
silently. The machine therefore says what it supports, and the host offers
only what both sides know.

### What a machine reports

One report per runtime, sent by the daemon after `ready` and again after a
runtime rescan, whole-report replacement (the same lifecycle as Raft's
`machine:runtime_models:catalog`, task #700):

```ts
export interface MachineConfigFormReport {
  readonly runtime: string;
  /** `RuntimeConfigForm.protocol` values this machine's OAR understands. */
  readonly protocols: readonly number[];
  /** The machine's own `configForm`, reduced to what decides compatibility. */
  readonly fields: readonly {
    readonly id: string;
    readonly kind: ConfigField["kind"];
    /** `select` only: the values this machine accepts. */
    readonly values?: readonly string[];
    /** `model` only: the selection modes this machine accepts (`ModelField.modes`). */
    readonly modes?: readonly ("inherit" | "preset" | "custom")[];
  }[];
  /** Diagnostics only. Never compared, never used to decide anything. */
  readonly oarVersion: string;
}

/** Pure: what the daemon puts on the wire. */
export function toMachineReport(form: RuntimeConfigForm, oarVersion: string): MachineConfigFormReport;
```

A runtime without a `configForm` on the machine sends no report for it. A
report is the machine's positive statement; nothing in it is derived from
`refusedSessionOptions`.

Reports are opt-in on the wire: a daemon that sends them also advertises a
`ready` capability (Raft: `runtime-config-form-report-v1`). That flag is what
lets the host tell "old daemon, sends nothing" from "new daemon, this runtime
has no form" and from "new daemon, report not arrived yet".

### What the host does with it

`effectiveForm(hostForm, report)` is a pure function in `@botiverse/oar/forms`
so every host computes the same thing. Per (machine, runtime):

| machine state | form the host serves |
|---|---|
| no capability flag (old daemon) | the runtime's **baseline**: the fields that runtime had when it migrated. Fields added to OAR later are hidden. Neither "everything" nor "nothing". |
| flag, no report stored yet | the last stored report for this machine if any, else the baseline |
| report, `protocols` does not include the host form's `protocol` | the baseline, and the mismatch is logged with both OAR versions |
| report | host fields whose `id` **and** `kind` match a reported field; a `select` keeps only values in both lists, a `model` only modes in both |

A field the host would hide is hidden; it is never sent as disabled with a
guessed value. If a **required** host field is hidden, the runtime is not
creatable on that machine and the form says so with a stable reason
(`config_form_unsupported`, naming the field), rather than serving a form that
cannot be submitted or launched.

The baseline is data in OAR beside each `configForm` (`baselineFieldIds`), set
once in the migration pull request for that runtime and never changed. It
equals what Raft serves today, so migration fixture equality (Migration, item 1)
also pins it.

### Submit and launch check it again

Hiding a field is presentation; the report is enforced twice more:

- **Submit** (create and edit): the host validates against the effective form.
  A new value for a field outside it is rejected (`field_unsupported_on_machine`).
  A stored value for such a field (the agent moved to an older machine, or the
  machine downgraded) is **kept unchanged** on save, not cleared and not
  rewritten; an unknown capability is not a reason to lose data.
- **Launch**: the daemon calls `toSessionOptions` with **its own** `configForm`.
  A value for a field id it does not know, a `select` value or a model mode
  it does not accept, fails launch with a typed refusal naming the field. It is never
  dropped silently. This is the last line, and it holds even if the host's
  report is stale.

### Required checks for the pull request that builds it

1. An old daemon (no flag) gets exactly the baseline; a field added to the
   host form after migration does not appear.
2. A report missing one optional field hides it; a report missing a required
   field makes the runtime not creatable with `config_form_unsupported`.
3. Same `id`, different `kind` is treated as unsupported.
4. A `select` value only the host knows is not offered and is rejected on submit.
5. An edit on a machine that no longer supports a field keeps the stored value
   byte-identical.
6. Launch with an unknown field id fails with the typed refusal; mutation that
   drops the value instead must turn the test red.
7. A report with an unknown protocol falls back to the baseline.
8. A model mode only the host knows (say `custom` added later under the same
   field id) is not offered, is rejected on submit, and refuses launch.

Dynamic model lists are not capabilities: they are the listing.

## Raft host integration

Stays in Raft: the v2 wire protocol and the web and mobile renderers; saved
provider connections; credential storage; the stored `RuntimeConfig` format;
the frozen v1 forms that installed apps still request.

Moves to OAR: which fields a runtime has, their stable ids, English default
copy and translation keys, where their options come from, validation, and
the mapping to `SessionOptions`.

The Raft server translates a `configForm` into a v2 form definition, fills
the model source from the machine's `listModels` result, applies the machine
capability report, and translates copy by key. It maps `FormValues` to and
from its own `RuntimeConfig`, applies secret edits to the credentials it
stores, and validates with `mode` and `stored` from that storage. The daemon
maps a stored `RuntimeConfig` and the resolved credentials to `LaunchValues`
and calls `toSessionOptions` to launch.

Environment variables and a custom executable (`command`) stay host and
construction inputs in this migration, not form fields: no current runtime
form owns them generically. A setting only one runtime has can become a typed
field of that runtime's form when one explicitly owns it.

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

1. Final type names stay open until the first migration pull request
   (Grok) uses them (HaoHao).

Resolved:
- `ModelListing` lives in `@botiverse/oar/forms`, with a pure
  `toModelListing(listModelsResult)`, so a host builds one without loading a
  runtime; acquiring the result stays runtime-side (HaoHao, Huaihuai).
- `env` and `command` stay host and construction inputs in this migration
  (Huaihuai).
- Secret edits are resolved by the host before the pure mapping (Huaihuai).
