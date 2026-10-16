import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { expect, test } from "vitest";
import {
  baselineForms, configForms, toModelListing, toSessionOptions, validateConfig,
  type FormValues, type ModelListing, type RuntimeConfigForm,
} from "../packages/oar/src/forms/index.js";

// docs/spec/config-form.md: the entry loads no runtime SDK and nothing outside forms/.
test("the forms entry bundles with no externals, no Node imports, and nothing outside forms/", async () => {
  const result = await build({
    entryPoints: ["packages/oar/src/forms/index.ts"], bundle: true, platform: "browser", format: "esm", write: false, metafile: true,
    plugins: [{ name: "no-node", setup(builder) {
      // oxlint-disable-next-line require-unicode-regexp
      builder.onResolve({ filter: /^node:/ }, (args) => ({ errors: [{ text: `Node import ${args.path} from ${args.importer}` }] }));
    } }],
  });
  expect(Object.values(result.metafile.outputs).flatMap((output) => output.imports)).toEqual([]);
  expect(Object.keys(result.metafile.inputs).filter((file) => !file.startsWith("packages/oar/src/forms/"))).toEqual([]);
});

/**
 * The side-effect boundary the entry promises: importing it and calling its
 * functions adds no global, and leaves no timer, socket or child process
 * running. (Node builtins and outside modules are ruled out by the bundle test.)
 */
const SIDE_EFFECT_PROBE = String.raw`
const before = new Set(Object.getOwnPropertyNames(globalThis));
const resources = process.getActiveResourcesInfo().length;
const forms = await import(process.argv[1]);
const grok = forms.configForms.grok;
const listing = forms.toModelListing({ kind: "ok", models: [{ id: "grok-4" }] });
forms.validateConfig(grok, { model: { kind: "preset", id: "grok-4" } }, { mode: "create", models: listing });
forms.toSessionOptions(grok, { model: { kind: "preset", id: "grok-4" } });
const added = Object.getOwnPropertyNames(globalThis).filter((name) => !before.has(name));
if (added.length > 0) { console.error("global written: " + added.join(",")); process.exit(3); }
if (process.getActiveResourcesInfo().length > resources) { console.error("left running: " + process.getActiveResourcesInfo().join(",")); process.exit(4); }
`;

async function probeBundle(banner: string): Promise<number> {
  const dir = mkdtempSync(path.join(tmpdir(), "oar-forms-probe-"));
  try {
    const result = await build({
      entryPoints: ["packages/oar/src/forms/index.ts"], bundle: true, platform: "neutral", format: "esm", write: false,
      banner: { js: banner },
    });
    const file = path.join(dir, "forms.mjs");
    writeFileSync(file, result.outputFiles[0]?.text ?? "");
    execFileSync(process.execPath, ["--input-type=module", "-e", SIDE_EFFECT_PROBE, pathToFileURL(file).href], { stdio: "pipe" });
    return 0;
  } catch (error) {
    const status: unknown = typeof error === "object" && error !== null ? Reflect.get(error, "status") : undefined;
    return typeof status === "number" ? status : -1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("importing and using the forms entry writes no global and leaves nothing running", async () => {
  expect(await probeBundle("")).toBe(0);
});

test("the side-effect probe fails when the entry writes a global or leaves a timer (negative controls)", async () => {
  expect(await probeBundle("globalThis.__formsSideEffect = 1;")).toBe(3);
  expect(await probeBundle("setInterval(() => {}, 60_000);")).toBe(4);
});

const grokForm = configForms.grok;
if (grokForm === undefined) {
  throw new Error("Grok has no config form");
}
const grok: RuntimeConfigForm = grokForm;
const live: ModelListing = toModelListing({ kind: "ok", models: [
  { id: "grok-4", effortLevels: ["low", "high"] },
  { id: "grok-code" },
] });
const unavailable: ModelListing = toModelListing({ kind: "error", reason: "timeout" });
const codes = (form: RuntimeConfigForm, values: FormValues, context: Parameters<typeof validateConfig>[2]) =>
  validateConfig(form, values, context).map((issue) => `${issue.field}:${issue.code}`);

test("toModelListing: not enumerated is a status with a reason, never an empty live list", () => {
  expect(live.status).toBe("live");
  expect(toModelListing({ kind: "ok", models: [] })).toEqual({ status: "unavailable", reason: "empty" });
  expect(toModelListing({ kind: "unauthenticated" })).toEqual({ status: "unavailable", reason: "unauthenticated" });
  expect(toModelListing({ kind: "unsupported", reason: "x" }, [{ id: "bundled" }]))
    .toEqual({ status: "fallback", source: "bundled", reason: "unsupported", models: [{ id: "bundled" }] });
});

// The baseline old daemons receive is frozen at migration: pinned here, not derived from configForm.
const GROK_BASELINE_AT_MIGRATION: RuntimeConfigForm = {
  protocol: 1,
  runtime: "grok",
  fields: [
    {
      id: "model", kind: "model", modes: ["preset"], required: true,
      label: { key: "runtime_form.grok.model.label", en: "Model" },
      hint: { key: "runtime_form.grok.model.hint", en: "Models available from this computer's Grok CLI." },
    },
    {
      id: "reasoningEffort", kind: "effort", modelField: "model", required: false,
      label: { key: "runtime_form.grok.reasoning_effort.label", en: "Reasoning" },
      hint: { key: "runtime_form.grok.reasoning_effort.hint", en: "Available values depend on the selected model." },
    },
  ],
};

test("Grok's baseline is its own frozen copy, pinned to the form at migration", () => {
  expect(baselineForms.grok).toEqual(GROK_BASELINE_AT_MIGRATION);
  // A separate object: editing configForm must not reach old daemons.
  expect(baselineForms.grok).not.toBe(grok);
  expect(grok).toEqual(GROK_BASELINE_AT_MIGRATION);
});

test("create: a preset must be listed; Grok offers no default and no typed id", () => {
  expect(codes(grok, { model: { kind: "preset", id: "grok-4" }, reasoningEffort: "high" }, { mode: "create", models: live })).toEqual([]);
  expect(codes(grok, { model: { kind: "preset", id: "gone" } }, { mode: "create", models: live })).toEqual(["model:model_not_listed"]);
  expect(codes(grok, { model: { kind: "preset", id: "grok-4" } }, { mode: "create", models: unavailable })).toEqual(["model:model_not_listed"]);
  expect(codes(grok, { model: { kind: "inherit" } }, { mode: "create", models: live })).toEqual(["model:mode_not_allowed"]);
  expect(codes(grok, { model: { kind: "custom", name: "x" } }, { mode: "create", models: live })).toEqual(["model:mode_not_allowed"]);
  expect(codes(grok, {}, { mode: "create", models: live })).toEqual(["model:required"]);
  expect(codes(grok, { model: { kind: "preset", id: "grok-4" }, extra: "x" }, { mode: "create", models: live })).toEqual(["extra:unknown_field"]);
});

test("effort: only what the chosen model lists; unknown levels offer nothing", () => {
  expect(codes(grok, { model: { kind: "preset", id: "grok-4" }, reasoningEffort: "ultra" }, { mode: "create", models: live })).toEqual(["reasoningEffort:effort_not_offered"]);
  expect(codes(grok, { model: { kind: "preset", id: "grok-code" }, reasoningEffort: "low" }, { mode: "create", models: live })).toEqual(["reasoningEffort:effort_not_offered"]);
  expect(codes(grok, { model: { kind: "preset", id: "grok-code" } }, { mode: "create", models: live })).toEqual([]);
});

test("edit: an unlisted stored value is preserved; a new one is not; launch rules still apply", () => {
  const stored: FormValues = { model: { kind: "preset", id: "grok-4" }, reasoningEffort: "high" };
  expect(codes(grok, stored, { mode: "edit", stored, models: unavailable })).toEqual([]);
  expect(codes(grok, { model: { kind: "preset", id: "grok-5" } }, { mode: "edit", stored, models: unavailable })).toEqual(["model:model_not_listed"]);
  expect(codes(grok, { ...stored, reasoningEffort: "low" }, { mode: "edit", stored, models: unavailable })).toEqual(["reasoningEffort:effort_not_offered"]);
  expect(codes(grok, { model: { kind: "inherit" } }, { mode: "edit", stored: { model: { kind: "inherit" } }, models: unavailable })).toEqual(["model:mode_not_allowed"]);
});

test("toSessionOptions maps Grok's model and effort, and refuses rather than drops", () => {
  expect(toSessionOptions(grok, { model: { kind: "preset", id: "grok-4" }, reasoningEffort: "high" })).toEqual({ ok: true, options: { model: "grok-4", effort: "high" }, unmapped: {}, secrets: {} });
  expect(toSessionOptions(grok, { model: { kind: "preset", id: "grok-4" } })).toEqual({ ok: true, options: { model: "grok-4" }, unmapped: {}, secrets: {} });
  expect(toSessionOptions(grok, { model: { kind: "inherit" } })).toEqual({ ok: false, issues: [{ field: "model", code: "mode_not_allowed" }] });
  expect(toSessionOptions(grok, { model: { kind: "preset", id: "grok-4" }, fast: true })).toEqual({ ok: false, issues: [{ field: "fast", code: "unknown_field" }] });
});

// A synthetic form for the parts no migrated runtime uses yet.
const withSecret: RuntimeConfigForm = {
  protocol: 1, runtime: "test", fields: [
    { id: "model", kind: "model", modes: ["inherit", "preset", "custom"], required: true, label: { key: "k", en: "Model" } },
    { id: "provider", kind: "select", required: true, label: { key: "k", en: "Provider" }, options: [{ value: "default", label: { key: "k", en: "Default" } }, { value: "custom", label: { key: "k", en: "Custom" } }] },
    { id: "apiKey", kind: "secret", required: true, label: { key: "k", en: "API key" }, visibleWhen: { field: "provider", in: ["custom"] } },
  ],
};

test("secrets: edits on submit; a required one resolving to nothing is secret_missing, never omitted", () => {
  const base = { model: { kind: "inherit" as const }, provider: "custom" };
  expect(codes(withSecret, { ...base, apiKey: { kind: "keep" } }, { mode: "create", models: live })).toEqual(["apiKey:required"]);
  expect(codes(withSecret, { ...base, apiKey: { kind: "keep" } }, { mode: "edit", stored: base, models: live })).toEqual([]);
  expect(codes(withSecret, { ...base, apiKey: { kind: "clear" } }, { mode: "edit", stored: base, models: live })).toEqual(["apiKey:required"]);
  expect(toSessionOptions(withSecret, { ...base, apiKey: { present: false } })).toEqual({ ok: false, issues: [{ field: "apiKey", code: "secret_missing" }] });
  // A resolved secret is handed back apart from ordinary values, never dropped.
  expect(toSessionOptions(withSecret, { ...base, apiKey: { present: true, value: "sk-1" } }))
    .toEqual({ ok: true, options: {}, unmapped: { provider: "custom" }, secrets: { apiKey: "sk-1" } });
});

test("an edit must say what was stored: the context type does not let a missing `stored` pass as a create", () => {
  // @ts-expect-error -- edit without stored
  const forgot: Parameters<typeof validateConfig>[2] = { mode: "edit", models: live };
  expect(forgot.mode).toBe("edit");
});

test("an inactive branch is neither required nor launched", () => {
  expect(codes(withSecret, { model: { kind: "inherit" }, provider: "default" }, { mode: "create", models: live })).toEqual([]);
  // The hidden apiKey resolving to nothing is not secret_missing: an inactive branch does not launch.
  expect(toSessionOptions(withSecret, { model: { kind: "custom", name: "m" }, provider: "default", apiKey: { present: false } }))
    .toEqual({ ok: true, options: { model: "m" }, unmapped: { provider: "default" }, secrets: {} });
});
