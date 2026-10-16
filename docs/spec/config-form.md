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
| report | host fields whose `id` **and** `kind` match a reported field; a `select` keeps only values in both lists |

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
  A value for a field id it does not know, or a `select` value it does not
  accept, fails launch with a typed refusal naming the field. It is never
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

1. ~~Where `ModelListing` lives~~ (HaoHao): in `@botiverse/oar/forms`, with a
   pure `toModelListing(listModelsResult)`. It is plain data and
   `validateConfig` takes it, so a host must be able to build one without
   loading a runtime. Final type names stay open until the first migration
   pull request (Grok) uses them.
2. Whether `env` stays a field kind or remains a host-level setting.
3. Whether the Raft-only `command` override (a custom executable) is a field
   or a constructor setting ([capabilities.md](../design/capabilities.md#a-runtimes-own-settings)).
