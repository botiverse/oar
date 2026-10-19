# Runtime config form

> **Status: SHIPPED in part.** `@botiverse/oar/forms` shipped in 0.67.0 with
> Grok's form (#417 to #424): the form and value types, `configForms`,
> `baselineForms`, `toModelListing`, `validateConfig` and `toSessionOptions`.
> [Machine capability reporting](#machine-capability-reporting), with its
> machine states and launch outcomes, is a draft (2026-10-16): nothing in it
> is built.
> Codex and Built-in / Pi are not migrated. Origin: Raft
> `#wg-runtime-form:3fb4c626`, at artin's direction (the agent-creation form
> moves from the Raft host into OAR). Interface shape: HaoHao. Runtime
> contract review: Huaihuai. Draft and Raft integration: archer.

A host that lets a person create an agent asks the same question for every
runtime: which settings can this runtime take, which values may each have,
and how do the chosen values become the options a session opens with.
Without a form, each host answers it by hand, once per runtime, in its own
code. The form keeps the answer next to the runtime that owns it.

`configForms[runtimeId]` describes a runtime's settings. Pure functions
beside it validate chosen values and turn them into `SessionOptions`. All
of it lives in `@botiverse/oar/forms`, an entry that loads no runtime SDK.

## Principles

1. **The runtime that owns a setting describes it.** Adding a runtime or a
   setting is one change in OAR, not one per host.
2. **Presence is the capability** ([capabilities.md](../design/capabilities.md#1-a-whole-operation-is-a-member-that-may-be-absent)).
   A runtime without a form has no entry in `configForms`. A field the form
   does not list is not configurable, whatever `refusedSessionOptions` says:
   a missing refusal is not a grant.
3. **Not enumerated is not none.** A model list that could not be read is a
   status (`unavailable` with a reason), never an empty list, and never a
   reason to clear a value the host already saved.
4. **No guessing.** Where a runtime does not tell OAR what a model supports,
   the form offers nothing for it (an effort under a typed or unlisted model
   is `effort_not_offered`); it does not invent options that would then be
   required.
5. **Data and behavior are separate.** A form is plain data a host can
   serialize. Validation and the mapping to `SessionOptions` are pure
   functions beside it.
6. **Storage is the host's.** How a host stores a configuration (Raft's
   versioned `RuntimeConfig`, saved provider connections, credentials) is
   not OAR's. OAR's value shape must keep every distinction a host needs to
   store, so nothing is lost on the way to `SessionOptions`.

## Shape

[`forms/types.ts`](../../packages/oar/src/forms/types.ts) is normative; in
brief:

```ts
// @botiverse/oar/forms: no runtime SDK, no side effect on import.
export interface RuntimeConfigForm {
  readonly protocol: 1;
  readonly runtime: string;            // the Runtime.id it describes
  readonly fields: readonly ConfigField[];
}

export type ConfigField =
  | ModelField | EffortField | SelectField | SecretField
  | TextField | BooleanField;

export interface CopyText { readonly key: string; readonly en: string } // stable translation key, English default

interface FieldBase {
  readonly id: string;                 // stable; never changes with its copy
  readonly label: CopyText;
  readonly hint?: CopyText;
  readonly required: boolean;
  /** Shown only when another field has one of these values. */
  readonly visibleWhen?: { readonly field: string; readonly in: readonly string[] };
}

export type ModelMode = "inherit" | "preset" | "custom";

/** Options from `Runtime.listModels` on the machine that will run the agent. */
export interface ModelField extends FieldBase {
  readonly kind: "model";
  /**
   * The selections the form offers, declared, not implied: `inherit` (the
   * runtime's default), `preset` (a listed model), `custom` (a typed id).
   * `validateConfig` rejects a new value whose mode is not listed, and
   * `toSessionOptions` one outside `launchModes`; hiding it in the UI is not
   * enough.
   */
  readonly modes: readonly ModelMode[];
  /**
   * What a launch accepts, when wider than what the form offers (a stored
   * value from an older create path or an API). Declared from the runtime's
   * verified launch behavior; defaults to `modes`. It maps a value to launch
   * options; it does not promise the provider accepts the model id.
   */
  readonly launchModes?: readonly ModelMode[];
}

/** Options from the chosen model's `ModelEntry.effortLevels`. */
export interface EffortField extends FieldBase {
  readonly kind: "effort";
  readonly modelField: string;
}

export interface SelectField extends FieldBase {
  readonly kind: "select";
  readonly options: readonly { readonly value: string; readonly label: CopyText }[];
}

/** Write-only: a stored value is never read back into the form. */
export interface SecretField extends FieldBase { readonly kind: "secret" }
export interface TextField extends FieldBase { readonly kind: "text"; readonly format?: "url" }
export interface BooleanField extends FieldBase { readonly kind: "boolean" }
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

export type FormValue = ModelValue | SecretEdit | string | boolean | null;
export type FormValues = Readonly<Record<string, FormValue>>;
```

An OAR form's `modes` state what the runtime's launch accepts; a host that
offers less narrows them ([host narrowing](#host-narrowing)). On edit, an
unchanged stored value whose mode is in `launchModes` is kept even when the
form no longer offers that mode.

### Hidden fields

A field can be hidden for two different reasons, and they launch differently.

- **Inactive branch.** Its `visibleWhen` is not met (an API key field while
  the default provider is chosen): `isActive(field, values)` is true only
  when the other field's value is a string in `in`. `validateConfig` does
  not check an inactive field, and `toSessionOptions` does not launch it: by
  the form's own rule it is not part of this configuration. A host may keep
  it in storage so switching back restores it, but it never launches.
- **Unsupported on the machine.** The field is active by the form's rules but
  the machine's capability report does not support it (or the value or mode it
  holds). A stored value here is part of the configuration the user chose, so
  it is **never silently removed from the launch**: dropping it would launch a
  different agent and contradict the rule that an unknown field or value is
  refused, not ignored.

The resulting launch outcome (`launchable`, `needs_fix`, `unconfirmed`) is
defined once, in [Stored values and launch](#stored-values-and-launch).

### Model listing

```ts
export type ModelListing =
  | { readonly status: "live"; readonly models: readonly ModelEntry[] }
  | { readonly status: "fallback"; readonly source: "bundled"; readonly reason: ListingReason; readonly models: readonly ModelEntry[] }
  | { readonly status: "unavailable"; readonly reason: ListingReason };

export type ListingReason =
  | "unauthenticated" | "timeout" | "failed" | "empty" | "machine_offline" | "unsupported";
```

`toModelListing(outcome, bundled?)` builds one. `outcome` is the
`ListModelsResult`, or a `ListingFailure` the host saw instead
(`{ kind: "error", reason: "timeout" | "failed" | "machine_offline" }`);
`bundled` is a list the host supplies.

| outcome | status | options |
|---|---|---|
| `ok` with models | `live` | the models |
| `ok` with none (`empty`), `unauthenticated`, `unsupported`, or a `ListingFailure`, and a bundled list exists | `fallback`, `source: "bundled"`, the reason | the bundled list |
| the same, no bundled list | `unavailable`, the reason | none |

A `fallback` always carries its reason and source, so an authentication
failure is never shown as a live list. `ModelListing` is a shared, SDK-free
type in the `forms` entry; acquiring the outcome (calling `listModels` on a
machine) is separate and runtime-side. `listedModels(listing)` is the
models a listing offers, none when `unavailable`.

### Validation

```ts
export type ValidationContext =
  | { readonly mode: "create"; readonly models: ModelListing }
  | { readonly mode: "edit"; readonly stored: FormValues; readonly models: ModelListing };

export function validateConfig(
  form: RuntimeConfigForm,
  values: FormValues,
  context: ValidationContext,
): readonly ConfigIssue[];           // [{ field, code }]
```

An issue's `code` is a stable key a host translates: `required`,
`invalid_shape`, `mode_not_allowed`, `model_not_listed`, `model_disabled`,
`effort_not_offered`, `option_not_offered`, `secret_missing` or
`unknown_field` (a value whose id the form does not list).

Two questions are kept apart:

- **Preservation.** On `edit`, a `preset` model equal to the stored one is
  not rejected because it is missing from the listing (a `fallback` or
  `unavailable` one above all): "not enumerated" is never a reason to reject
  or clear what was stored. On `create` there is nothing stored, so a
  `preset` must be in the listing.
- **Launch validity.** Everything else still applies to every value, stored
  or new: its shape, a declared model mode, a declared option of a select,
  the runtime's explicit capability on that machine, and known constraints
  such as an authentication mode. An unavailable listing only lifts the
  list-membership check. The capability check waits on the unbuilt
  [machine report](#machine-capability-reporting), and no shipped form has an
  authentication constraint.

Which listing entry a model value runs as decides the effort it offers: a
`preset` runs as its own entry; `inherit` runs as the entry marked
`default: true`, and so does an optional model left empty, which launches
exactly like `inherit` (the runtime's default). With no entry marked
default, the runtime's default model offers no effort. An unchanged stored
effort on an unchanged model is preserved whatever the listing now says,
because the entry a model runs as can move (the runtime's default above
all). A listed entry carrying `disabled` cannot be newly chosen
(`model_disabled`); an unchanged stored one is preserved like an unlisted
one.

A secret field's value is a `SecretEdit` (`set` with an empty value is
`invalid_shape`). A required secret needs `set` on create; on edit `keep`,
or no value at all, also passes, while `clear` and `unset` are `required`.

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

export type FormSessionOptions = Partial<Pick<SessionOptions, "model" | "effort">>;

export function toSessionOptions(form: RuntimeConfigForm, values: LaunchValues): SessionMapping;

export type SessionMapping =
  | { ok: true; options: FormSessionOptions; unmapped: Readonly<Record<string, string | boolean>>; secrets: Readonly<Record<string, string>> }
  | { ok: false; issues: readonly ConfigIssue[] };
```

A `preset` becomes `model: id`, a `custom` `model: name`, and `inherit` (or
an empty optional model) no `model`; an effort value becomes `effort`. A
mode outside `launchModes` is `mode_not_allowed` and an unknown field id
`unknown_field`; any issue fails the whole mapping. Active select, text and
boolean values have no shared `SessionOptions` member; they come back in
`unmapped`, by field id, for the runtime's own mapping. Resolved secrets
come back in `secrets`, kept apart so a caller never handles them as
ordinary values. The caller applies or refuses each one; none is dropped.

A required secret that resolves to `present: false` is the issue
`secret_missing`; it is never mapped to an empty or omitted option. Resolved
secrets go only into the launch; they are never returned to a form client.

## The `forms` entry

- `@botiverse/oar/forms` exports `configForms` (by `Runtime.id`), the frozen
  `baselineForms`, the shared types (`ModelListing` included),
  `toModelListing`, `listedModels`, `isActive`, `validateConfig` and
  `toSessionOptions`. Each form lives in `forms/runtimes/<id>.ts`, so the
  entry depends on no runtime; a runtime that needs its form imports it from
  there, not the other way round.
- [`tests/config-form.test.ts`](../../tests/config-form.test.ts) bundles the
  entry for the browser and fails on any external or `node:` import and on
  any module outside `forms/`, so no runtime SDK can enter it. It also
  imports the bundle in a fresh Node process, calls its functions, and fails
  when a global was written or a timer, socket or child process was left
  running; negative controls show both checks fire.

| runtime | fields |
|---|---|
| grok | `model` (model; `inherit`, `preset`, `custom`; optional; its hint says a typed id the CLI does not know fails when the agent starts) and `reasoningEffort` (effort of `model`; optional), mapped to `model` and `effort` |

### The baseline form

`baselineForms[id]` is what a machine that sends no capability report gets
(state `legacy` [below](#machine-states)). It is the **complete**
definition, not a list of field names: a full `RuntimeConfigForm` with its
options, model modes and every rule, kept as its own literal beside the
runtime's form (`grokBaselineForm` in `forms/runtimes/grok.ts`), so editing
the form never reaches old daemons. Because `validateConfig` and
`toSessionOptions` are pure functions of form data, freezing the form
freezes their behavior for it. Two consequences:

- A change to how those functions interpret an existing form is a protocol
  change: it bumps `protocol`, and the baseline keeps the old one.
- The baseline states what the runtime accepts, like every OAR form; it is
  frozen at the first release that carries it (Grok: 0.67.0), and a test
  pins it afterwards (`GROK_BASELINE_AT_MIGRATION`).

### Host narrowing

A form states what the runtime accepts, not what one host chooses to offer.
A host that offers less narrows the form on its side, and may only narrow:
it can drop model modes or select options and make an optional field
required, never add a mode, option or field. Its narrowed form must still
satisfy `modes ⊆ launchModes`, as every OAR form and baseline does (pinned
by the test above). It keeps the OAR form's modes as the narrowed field's
`launchModes`, so a stored value the host no longer offers is still
preserved on edit and still launches. Labels and hints are display copy,
not value semantics: a host may replace them.

## Machine capability reporting

> **Draft, not built.** The entry has no report type, `toMachineReport` or
> `effectiveForm` yet, and no machine state or launch outcome below exists
> in code.

The host and every machine pin their own OAR. A form built from the host's
form can name a field, a mode or a value that the machine's OAR does not
know; launching with it would fail, or worse, the value would be dropped
silently. The machine therefore states what it supports, and the host offers
only what both sides know.

### What a machine reports

One message per detection round, covering **every** runtime the round
detected. It is the whole picture or nothing, so "no entry" never has to be
interpreted:

```ts
export interface MachineConfigFormReport {
  /** Bind to the connection and the round; see "Freshness" below. */
  readonly connectionEpochId: string;
  readonly round: number;                 // per daemon instance, strictly increasing
  /** Form protocols this machine's OAR understands. */
  readonly protocols: readonly number[];
  readonly runtimes: Readonly<Record<string, RuntimeFormSupport>>;
  /** Diagnostics only. Never compared, never used to decide anything. */
  readonly oarVersion: string;
}

export type RuntimeFormSupport =
  | { readonly status: "absent" }        // detected; has no form on this machine
  | { readonly status: "present"; readonly fields: readonly FieldSupport[] };

/** Every field reports its accepted value domain, not just its id. */
export type FieldSupport =
  | { readonly id: string; readonly kind: "model"; readonly modes: readonly ModelValue["kind"][] }
  | { readonly id: string; readonly kind: "select"; readonly values: readonly string[] }
  | { readonly id: string; readonly kind: "effort" | "secret" | "text" | "boolean" };

/** Pure: what the daemon puts on the wire. */
export function toMachineReport(forms: Readonly<Record<string, RuntimeConfigForm | null>>, meta: ReportMeta): MachineConfigFormReport;
```

Nothing in a report is derived from `refusedSessionOptions`. `effort` reports
no domain because its options come from the machine's own `listModels`
result, which is already per machine. `secret` reports no domain either:
`SecretEdit` is an edit the host applies to its own credential store, not
stored configuration, so it is never what a machine is checked against; the
machine only says whether it accepts the field. (`env` is not a field kind
this round; it stays a host setting.)

**A runtime missing from a complete batch** was not detected in that round.
That is not `pending` (the batch has arrived) and not `absent` (that means
detected, no form): the runtime is `not_detected` on that machine, and the
host treats it exactly as it treats an undetected runtime today. It does not
offer the runtime, and the report says nothing more about it.

A daemon that sends reports advertises a `ready` capability (Raft:
`runtime-config-form-report-v1`). The flag only says "this daemon reports";
it is never itself evidence of what a runtime supports.

### Freshness

The host keeps one report per machine and accepts a new one only if its
`connectionEpochId` is the machine's current connection and its `round` is
higher than the stored one. Anything else is discarded and counted. A report
from an earlier connection is never current evidence: on reconnect the stored
report is dropped, and the machine is `pending` until the new connection's
first report arrives.

### Machine states

Per machine, the host is in exactly one state. `effectiveForm(hostForm,
state)` is a pure function in `@botiverse/oar/forms`, so every host computes
the same result.

| state | when | form served | submit (create / edit) | launch |
|---|---|---|---|---|
| **legacy** | no capability flag (old daemon) | the runtime's **baseline form**, unchanged | validated against the baseline form | daemon's own path, as today |
| **pending** | flag, no current-connection report yet | none: the runtime shows "checking this computer" (`machine_capabilities_pending`) | rejected, retryable | daemon checks with its own form (below) |
| **incompatible** | report, no protocol in common with the host form | none (`config_form_incompatible`, both OAR versions in the log) | rejected | daemon checks with its own form |
| **reported** | current report, common protocol | the host form reduced by the report | validated against that reduced form | daemon checks with its own form |

Protocol choice is the only negotiation: the host uses the highest protocol
both sides list. There is no other downgrade path this round.

**Reduction** (state `reported`): a host field survives only if the report
has the same `id` and `kind`, and its domain is the intersection: model
`modes`, select `values`. A runtime whose report entry is
`absent` has no OAR form on that machine. If a **required** host field does
not survive, or survives with an empty domain, the runtime is not creatable
on that machine (`config_form_unsupported`, naming the field). The host never
serves a form that cannot be submitted or launched.

### Stored values and launch

Two different things can hide a field, and they launch differently:

- **Branch-hidden**: its `visibleWhen` is not met (see "Hidden fields"). That
  is the form's own declared rule, so its stored value does not launch.
- **Unsupported**: the machine's report reduced it away. This is never a
  reason to drop a stored value from a launch, because the stored value is
  part of the agent's active configuration and silently launching without it
  would contradict "an unknown field or value is refused".

For a stored configuration on a given machine the host computes one explicit
outcome, shown on the agent and returned by the launch path:

| outcome | when | launch |
|---|---|---|
| `launchable` | every stored active value is in the effective form | allowed |
| `needs_fix` | a stored active value (field, model mode or select value) is unsupported on this machine | refused with `stored_value_unsupported_on_machine`, naming the field; the user edits it or moves the agent |
| `unconfirmed` | the machine is `pending` or `incompatible` | the host does not decide; the daemon's own check below is final |

The rules that keep data and the rules that refuse a launch are separate:

- **Keeping data.** A stored value for a field, mode or value the machine
  does not support (the agent moved, the machine downgraded, the report is
  pending) is kept byte-identical by every save that **does not edit that
  field**. The system never clears or rewrites it on its own.
- **Fixing it.** The user may always edit such a field: clear it (if the
  field is optional) or replace it with a value inside the effective form.
  That is how `needs_fix` is resolved, so it must never be rejected. Only a
  **new** value outside the effective form is rejected
  (`field_unsupported_on_machine`).
- **Refusing a launch.** Keeping a value does not make it launchable. At
  launch credentials are resolved at the launch boundary, then the daemon calls
  `toSessionOptions` with **its own** form. A field id, mode or
  value it does not support fails the launch with a typed refusal naming the
  field. It is never dropped silently. This holds in every state, including
  `pending` and a stale host view.

### Required checks for the pull request that builds it

1. `legacy` serves the baseline form exactly; a field, option or mode added
   to the host form after migration does not appear.
2. A report missing an optional field hides it; one missing a required
   field, or leaving it an empty domain, gives `config_form_unsupported`.
3. Same `id`, different `kind` is unsupported.
4. A select value or model mode only the host knows is not
   offered and is rejected on submit.
5. A report with a stale `connectionEpochId` or a non-increasing `round` is
   discarded; after a reconnect the machine is `pending`, not `reported`.
6. `pending` and `incompatible` reject submit with their stable codes.
7. A save on a machine that does not support a stored value keeps it
   byte-identical; the outcome is `needs_fix` and a launch with it fails with
   the typed refusal. A mutation that drops the value instead must turn the
   test red.
8. A field whose id is unchanged but which later gains a mode (e.g. `custom`)
   or a select value: an old machine's report does not list it, so it is not
   offered, a new value using it is rejected, and a stored one is `needs_fix`.
9. A branch-hidden stored value does not reach `toSessionOptions`; an
   unsupported stored value is never silently omitted.
10. A `needs_fix` agent can be fixed: an edit that clears the unsupported
    optional value, or replaces it with a supported one, is accepted and the
    outcome becomes `launchable`.
11. A runtime missing from a complete batch is `not_detected`: not offered,
    and not treated as `pending` or `absent`.

## Raft host integration

Stays in Raft: the v2 wire protocol and the web and mobile renderers; saved
provider connections; credential storage; the stored `RuntimeConfig` format;
the frozen v1 forms that installed apps still request.

Moves to OAR: which fields a runtime has, their stable ids, English default
copy and translation keys, where their options come from, validation, and
the mapping to `SessionOptions`.

The Raft server translates a form into a v2 form definition, fills
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

### What clients see (and which pull request changes it)

The machine states and launch outcomes above are new behavior, not a move of
existing code. They are kept out of the migration pull requests:

- **Migration pull requests run in `legacy` only.** Until the daemon sends
  capability reports, every machine is `legacy`, so the host serves the
  runtime's baseline form, narrowed by the host ([host narrowing](#host-narrowing))
  to what Raft serves today. That is why fixture equality (Migration, item 1)
  can hold: no new state, outcome or error reaches a client in these pull
  requests.
- **Turning the states on is its own pull request** (daemon reporting plus
  the host's use of it), reviewed as a behavior change. It maps each new
  state onto what the v2 protocol and today's clients already show, and adds
  protocol only where nothing fits:

| new state or outcome | today's surface it maps to | protocol change |
|---|---|---|
| machine `pending` | runtime detection pending (Raft task #1268): the runtime is listed as still detecting and not yet creatable | none |
| machine `incompatible` | "this Computer must be updated" (the daemon requirement label in the runtime list; `recovery: "upgrade_required"` on the form request) | none |
| `config_form_unsupported` (a required field unsupported) | the runtime is not creatable on this Computer, with the existing availability reason and copy | none if an existing reason fits; otherwise a new reason value, in that pull request |
| stored value `needs_fix` | the agent's existing start-failure state, with a typed reason naming the field | a new start-failure reason value; clients that do not know it must fall back to the generic start-failure copy, verified before that pull request lands |
| submit `field_unsupported_on_machine` | a v2 field issue at the field's pointer, like any validation issue | none (issue codes are already open-ended) |

If a row turns out to need more than a new value in an existing open set, it
is split into its own protocol pull request with the client change, not
folded into the activation pull request.

## Migration

One runtime per pull request, in this order: **Grok** (done, 0.67.0), then
**Codex**, then **Built-in / Pi** (provider and saved connections are the
hardest; a provider is the authentication axis, not a third selector).

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
  (`e7061fcfb`) removed `src/config/`; no reason was recorded. This spec
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

1. Whether the entry becomes its own light package in this repository, so a
   host need not even install the SDKs `@botiverse/oar` depends on: decided
   when a host needs it.
