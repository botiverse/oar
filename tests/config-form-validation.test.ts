import { expect, test } from "vitest";
import type { FormValues, RuntimeConfigForm } from "../packages/oar/src/forms/types.js";
import { grokConfigForm as grok } from "../packages/oar/src/forms/runtimes/grok.js";
import { validateConfig } from "../packages/oar/src/forms/validate.js";
import { toSessionOptions } from "../packages/oar/src/forms/map.js";

const live = { status: "live", models: [{ id: "grok-4", effortLevels: ["low", "high"] }] } as const;
const codes = (form: RuntimeConfigForm, values: FormValues, context: Parameters<typeof validateConfig>[2]) =>
  validateConfig(form, values, context).map(issue => `${issue.field}:${issue.code}`);

const auditLabel = { key: "field", en: "Field" };
const scalarForm: RuntimeConfigForm = { protocol: 1, runtime: "custom", fields: [
  { id: "mode", kind: "select", required: false, label: auditLabel, options: [{ value: "active", label: auditLabel }] },
  { id: "flag", kind: "boolean", required: false, label: auditLabel },
  { id: "url", kind: "text", format: "url", required: false, label: auditLabel },
  { id: "secret", kind: "secret", required: true, label: auditLabel, visibleWhen: { field: "mode", in: ["active"] } },
] };
test.each([
  { mode: "unknown" }, { mode: true }, { flag: "yes" }, { url: false }, { url: "relative/path" },
  { mode: "active", secret: { present: true as const, value: "" } },
])("invalid scalar or resolved secret is refused at launch: %j", values => {
  expect(toSessionOptions(scalarForm, values).ok).toBe(false);
});
test("URL format is validated on submission", () => {
  expect(codes(scalarForm, { url: "relative/path" }, { mode: "create", models: live })).not.toHaveLength(0);
  expect(toSessionOptions(scalarForm, { url: "https://service.example/path" }).ok).toBe(true);
});
test.each(["model", "effort"] as const)("conflicting active %s fields cannot overwrite each other", kind => {
  const field = grok.fields.find(candidate => candidate.kind === kind);
  if (field === undefined) { throw new Error("missing field"); }
  const form = { ...grok, fields: [...grok.fields, { ...field, id: "second" }] };
  const value = kind === "model" ? { kind: "custom" as const, name: "grok-4" } : "high";
  expect(toSessionOptions(form, { [field.id]: value, second: value }).ok).toBe(false);
});
test("nested hidden fields neither require nor send stored branch values", () => {
  const nested: RuntimeConfigForm = { ...scalarForm, fields: [
    ...scalarForm.fields.slice(0, 1),
    { id: "branch", kind: "text", required: false, label: auditLabel, visibleWhen: { field: "mode", in: ["active"] } },
    { id: "leaf", kind: "text", required: true, label: auditLabel, visibleWhen: { field: "branch", in: ["nested"] } },
  ] };
  expect(codes(nested, { branch: "nested" }, { mode: "create", models: live })).toEqual([]);
  expect(toSessionOptions(nested, { branch: "nested", leaf: "old" })).toMatchObject({ ok: true, unmapped: {} });
});
test("a typed Grok model id uses its own listed effort levels", () => {
  expect(codes(grok, { model: { kind: "custom", name: "grok-4" }, reasoningEffort: "high" }, { mode: "create", models: live })).toEqual([]);
  expect(codes(grok, { model: { kind: "custom", name: "grok-4" }, reasoningEffort: "ultra" }, { mode: "create", models: live })).toEqual(["reasoningEffort:effort_not_offered"]);
});

test("a typed id without a listing entry supplies no effort menu", () => {
  expect(codes(grok, { model: { kind: "custom", name: "unlisted" }, reasoningEffort: "high" }, { mode: "create", models: live }))
    .toEqual(["reasoningEffort:effort_not_offered"]);
});

test("an unset optional duplicate has no launch contribution", () => {
  const field = grok.fields.find(candidate => candidate.kind === "model");
  if (field === undefined) { throw new Error("missing model field"); }
  const form = { ...grok, fields: [...grok.fields, { ...field, id: "other" }] };
  expect(toSessionOptions(form, { model: { kind: "custom", name: "grok-4" } })).toMatchObject({ ok: true, options: { model: "grok-4" } });
});
