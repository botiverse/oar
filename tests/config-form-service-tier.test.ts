import { expect, test } from "vitest";
import {
  serviceTierChoices, toModelListing, toSessionOptions, validateConfig,
  type FormValues, type ModelListing, type RuntimeConfigForm,
} from "../packages/oar/src/forms/index.js";

// docs/spec/config-form.md, "Service tier": a field written like effort, bound
// to a model field; `default` is the explicit opt-out, unset is the runtime's own choice.
const label = { key: "k", en: "Label" };
const tiered: RuntimeConfigForm = {
  protocol: 1, runtime: "test", fields: [
    { id: "model", kind: "model", modes: ["inherit", "preset", "custom"], required: false, label },
    { id: "serviceTier", kind: "serviceTier", modelField: "model", required: false, label },
  ],
};
// Codex-like: `priority` is the catalog default of some models; one model lists no tier at all.
const live: ModelListing = toModelListing({ kind: "ok", models: [
  { id: "gpt-sol", serviceTiers: ["priority", "flex"], defaultServiceTier: "priority", default: true },
  { id: "gpt-luna", serviceTiers: ["priority"] },
  { id: "gpt-mini" },
  { id: "gpt-bare", serviceTiers: [] },
] });
// Claude-like: the runtime cannot say which model runs when none is set.
const noDefault: ModelListing = toModelListing({ kind: "ok", models: [{ id: "opus", serviceTiers: ["fast"] }] });
const unavailable: ModelListing = toModelListing({ kind: "error", reason: "timeout" });
const codes = (form: RuntimeConfigForm, values: FormValues, context: Parameters<typeof validateConfig>[2]) =>
  validateConfig(form, values, context).map((issue) => `${issue.field}:${issue.code}`);
const sol = { kind: "preset", id: "gpt-sol" } as const;

test("serviceTierChoices: the opt-out `default` first, then the model's own tiers; nothing for a model that lists none", () => {
  expect(serviceTierChoices({ id: "gpt-sol", serviceTiers: ["priority", "flex"], defaultServiceTier: "priority" }))
    .toEqual({ values: ["default", "priority", "flex"], whenUnset: "priority" });
  expect(serviceTierChoices({ id: "opus", serviceTiers: ["fast"] })).toEqual({ values: ["default", "fast"] });
  // A listing that names `default` itself does not offer it twice.
  expect(serviceTierChoices({ id: "x", serviceTiers: ["default", "priority"], defaultServiceTier: "default" }))
    .toEqual({ values: ["default", "priority"], whenUnset: "default" });
  // A catalog default that is not one of the choices is not claimed.
  expect(serviceTierChoices({ id: "x", serviceTiers: ["priority"], defaultServiceTier: "flex" })).toEqual({ values: ["default", "priority"] });
  expect(serviceTierChoices({ id: "gpt-mini" })).toEqual({ values: [] });
  expect(serviceTierChoices({ id: "gpt-bare", serviceTiers: [] })).toEqual({ values: [] });
  expect(serviceTierChoices({ id: "only-default", serviceTiers: ["default"] })).toEqual({ values: [] });
  // Not enumerated offers nothing.
  expect(serviceTierChoices(undefined)).toEqual({ values: [] });
});

const create = { mode: "create", models: live } as const;

test("create: a tier the chosen model lists, the explicit opt-out `default`, or unset", () => {
  expect(codes(tiered, { model: sol, serviceTier: "priority" }, create)).toEqual([]);
  expect(codes(tiered, { model: sol, serviceTier: "flex" }, create)).toEqual([]);
  expect(codes(tiered, { model: sol, serviceTier: "default" }, create)).toEqual([]);
  expect(codes(tiered, { model: sol, serviceTier: null }, create)).toEqual([]);
  expect(codes(tiered, { model: sol }, create)).toEqual([]);
});

test("create: a tier the chosen model does not list is refused; a model not enumerated offers nothing", () => {
  // The CLI's `fast` alias is not codex's native id.
  expect(codes(tiered, { model: sol, serviceTier: "fast" }, create)).toEqual(["serviceTier:service_tier_not_offered"]);
  expect(codes(tiered, { model: { kind: "preset", id: "gpt-luna" }, serviceTier: "flex" }, create)).toEqual(["serviceTier:service_tier_not_offered"]);
  // A model that lists no tier offers nothing, not even the opt-out.
  expect(codes(tiered, { model: { kind: "preset", id: "gpt-mini" }, serviceTier: "default" }, create)).toEqual(["serviceTier:service_tier_not_offered"]);
  expect(codes(tiered, { model: { kind: "preset", id: "gpt-bare" }, serviceTier: "priority" }, create)).toEqual(["serviceTier:service_tier_not_offered"]);
  // A typed model is not enumerated: no guessing.
  expect(codes(tiered, { model: { kind: "custom", name: "gpt-sol" }, serviceTier: "priority" }, create)).toEqual(["serviceTier:service_tier_not_offered"]);
  expect(codes(tiered, { model: sol, serviceTier: "priority" }, { mode: "create", models: unavailable }))
    .toEqual(["model:model_not_listed", "serviceTier:service_tier_not_offered"]);
});

test("a tier is a string; a required one must be chosen", () => {
  expect(codes(tiered, { model: sol, serviceTier: true }, create)).toEqual(["serviceTier:invalid_shape"]);
  expect(codes(tiered, { model: sol, serviceTier: { kind: "inherit" } }, create)).toEqual(["serviceTier:invalid_shape"]);
  const required: RuntimeConfigForm = { ...tiered, fields: tiered.fields.map((field) => field.kind === "serviceTier" ? { ...field, required: true } : field) };
  expect(codes(required, { model: sol }, create)).toEqual(["serviceTier:required"]);
});

test("inherit: tiers come from the listing's `default: true` entry; none offers nothing and keeps what was stored", () => {
  const inherit = { kind: "inherit" } as const;
  expect(codes(tiered, { model: inherit, serviceTier: "flex" }, { mode: "create", models: live })).toEqual([]);
  // An empty optional model launches like inherit (#424).
  expect(codes(tiered, { serviceTier: "flex" }, { mode: "create", models: live })).toEqual([]);
  expect(codes(tiered, { model: null, serviceTier: "turbo" }, { mode: "create", models: live })).toEqual(["serviceTier:service_tier_not_offered"]);
  expect(codes(tiered, { model: inherit, serviceTier: "default" }, { mode: "create", models: live })).toEqual([]);
  expect(codes(tiered, { model: inherit, serviceTier: "turbo" }, { mode: "create", models: live })).toEqual(["serviceTier:service_tier_not_offered"]);
  expect(codes(tiered, { model: inherit, serviceTier: "fast" }, { mode: "create", models: noDefault })).toEqual(["serviceTier:service_tier_not_offered"]);
  const stored: FormValues = { model: inherit, serviceTier: "fast" };
  expect(codes(tiered, stored, { mode: "edit", stored, models: noDefault })).toEqual([]);
  expect(codes(tiered, { model: inherit, serviceTier: "default" }, { mode: "edit", stored, models: noDefault })).toEqual(["serviceTier:service_tier_not_offered"]);
});

// HaoHao, Raft 6b5c5423: the runtime owns its default model, so it can change between sessions.
test("edit: the default entry changed and no longer lists the stored tier; the unchanged value is kept", () => {
  const stored: FormValues = { model: { kind: "inherit" }, serviceTier: "flex" };
  const moved = toModelListing({ kind: "ok", models: [{ id: "gpt-sol", serviceTiers: ["priority", "flex"] }, { id: "gpt-luna", serviceTiers: ["priority"], default: true }] });
  expect(codes(tiered, stored, { mode: "edit", stored, models: moved })).toEqual([]);
  // A new choice is still checked against the new default.
  expect(codes(tiered, { model: { kind: "inherit" }, serviceTier: "flex" }, { mode: "edit", stored: { model: { kind: "inherit" } }, models: moved }))
    .toEqual(["serviceTier:service_tier_not_offered"]);
});

// HaoHao, Raft aca5a4f9: an empty optional model launches like inherit, so "model unchanged" includes both empty.
test("edit: an empty optional model, the default entry changed; the unchanged stored tier is kept", () => {
  const stored: FormValues = { serviceTier: "flex" };
  const moved = toModelListing({ kind: "ok", models: [{ id: "gpt-sol", serviceTiers: ["priority", "flex"] }, { id: "gpt-luna", serviceTiers: ["priority"], default: true }] });
  expect(codes(tiered, stored, { mode: "edit", stored, models: moved })).toEqual([]);
  expect(codes(tiered, { model: null, serviceTier: "flex" }, { mode: "edit", stored: { model: null, serviceTier: "flex" }, models: moved })).toEqual([]);
  // Empty on one side only is a changed model: the tier is a new choice.
  expect(codes(tiered, { model: { kind: "preset", id: "gpt-luna" }, serviceTier: "flex" }, { mode: "edit", stored, models: moved }))
    .toEqual(["serviceTier:service_tier_not_offered"]);
});

test("edit: an unchanged stored tier on an unchanged model is kept; a new one is not", () => {
  const stored: FormValues = { model: sol, serviceTier: "priority" };
  expect(codes(tiered, stored, { mode: "edit", stored, models: unavailable })).toEqual([]);
  const optedOut: FormValues = { model: sol, serviceTier: "default" };
  expect(codes(tiered, optedOut, { mode: "edit", stored: optedOut, models: unavailable })).toEqual([]);
  expect(codes(tiered, { model: sol, serviceTier: "flex" }, { mode: "edit", stored, models: unavailable })).toEqual(["serviceTier:service_tier_not_offered"]);
  // The kept tier belongs to the stored model: a changed model does not carry it.
  expect(codes(tiered, { model: { kind: "custom", name: "gpt-x" }, serviceTier: "priority" }, { mode: "edit", stored, models: unavailable }))
    .toEqual(["serviceTier:service_tier_not_offered"]);
  // A listed model that no longer lists the stored tier keeps it while neither changes (a save that does not edit it)…
  const luna: FormValues = { model: { kind: "preset", id: "gpt-luna" }, serviceTier: "flex" };
  expect(codes(tiered, luna, { mode: "edit", stored: luna, models: live })).toEqual([]);
  // …but switching to that model with the tier is a new choice, and refused.
  expect(codes(tiered, luna, { mode: "edit", stored, models: live })).toEqual(["serviceTier:service_tier_not_offered"]);
  // Clearing back to the runtime's own choice is always allowed.
  expect(codes(tiered, { model: sol, serviceTier: null }, { mode: "edit", stored, models: unavailable })).toEqual([]);
});

test("toSessionOptions maps a tier to SessionOptions.serviceTier; `default` and unset stay distinct", () => {
  expect(toSessionOptions(tiered, { model: sol, serviceTier: "priority" }))
    .toEqual({ ok: true, options: { model: "gpt-sol", serviceTier: "priority" }, unmapped: {}, secrets: {} });
  // The explicit opt-out reaches the launch by name: it turns a default special tier off.
  expect(toSessionOptions(tiered, { model: sol, serviceTier: "default" }))
    .toEqual({ ok: true, options: { model: "gpt-sol", serviceTier: "default" }, unmapped: {}, secrets: {} });
  // Unset leaves the runtime's own choice: no serviceTier at all.
  expect(toSessionOptions(tiered, { model: sol, serviceTier: null })).toEqual({ ok: true, options: { model: "gpt-sol" }, unmapped: {}, secrets: {} });
  expect(toSessionOptions(tiered, { model: sol })).toEqual({ ok: true, options: { model: "gpt-sol" }, unmapped: {}, secrets: {} });
  expect(toSessionOptions(tiered, { model: sol, serviceTier: true })).toEqual({ ok: false, issues: [{ field: "serviceTier", code: "invalid_shape" }] });
});
