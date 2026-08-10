/**
 * Bake form schema from fixtures and emit a single offline HTML demo.
 * Usage: npx --yes tsx scripts/bake-create-agent-demo.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFormSchema } from "../src/config/schema.js";
import { validateConfig, ConfigError } from "../src/config/validate.js";
import { effectiveSchema } from "../src/config/profile.js";
import {
  assertFixtureCoversRegistry,
  creatableDescriptors,
  deprecatedExcluded,
  fixtureDescriptors,
  RAFT_DRIVER_REGISTRY,
  RAFT_DEPRECATED_FOR_CREATE,
} from "../src/discovery/fixtures/raftRuntimes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

assertFixtureCoversRegistry();

const all = fixtureDescriptors();
const creatable = creatableDescriptors();
const baked = buildFormSchema(creatable);
const deprecated = deprecatedExcluded();

// Precompute one reject sample for the demo
let rejectSample: { body: unknown; error: string } | null = null;
try {
  validateConfig({
    raw: {
      runtime: "codex",
      model: "gpt-4.1",
      auth: { mode: "ambient" },
      reasoningEffort: "high", // unsupported on gpt-4.1
    },
    descs: creatable,
    submittedSnapshotId: baked.snapshotId,
    currentSnapshotId: baked.snapshotId,
  });
} catch (e) {
  if (e instanceof ConfigError) {
    rejectSample = {
      body: {
        runtime: "codex",
        model: "gpt-4.1",
        auth: { mode: "ambient" },
        reasoningEffort: "high",
      },
      error: e.message,
    };
  }
}
if (!rejectSample) {
  throw new Error("failed to produce reject sample for demo");
}

// Valid sample
const validSample = {
  runtime: "codex",
  model: "gpt-5.6",
  auth: { mode: "ambient" },
  reasoningEffort: "high",
  fastMode: false,
};
const validResult = validateConfig({
  raw: validSample,
  descs: creatable,
  submittedSnapshotId: baked.snapshotId,
  currentSnapshotId: baked.snapshotId,
});

const payload = {
  registry: [...RAFT_DRIVER_REGISTRY],
  deprecated: [...RAFT_DEPRECATED_FOR_CREATE],
  deprecatedExcluded: deprecated,
  unavailable: baked.unavailable,
  snapshotId: baked.snapshotId,
  schema: baked.schema,
  labels: baked.labels,
  detectedAll: all.map((d) => d.runtime),
  creatable: creatable.map((d) => d.runtime),
  samples: {
    valid: { body: validSample, ok: true, result: validResult },
    rejected: { ...rejectSample, ok: false },
  },
};

const outJson = join(root, "artifacts-local", "create-agent-form-schema.json");
mkdirSync(dirname(outJson), { recursive: true });
writeFileSync(outJson, JSON.stringify(payload, null, 2));

const dataJson = JSON.stringify(payload);
const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>OAR create-agent form demo</title>
<style>
  :root { font-family: ui-sans-serif, system-ui, sans-serif; color: #0f172a; }
  body { max-width: 920px; margin: 24px auto; padding: 0 16px 48px; background: #f8fafc; }
  h1 { font-size: 1.25rem; margin: 0 0 4px; }
  .sub { color: #64748b; font-size: 0.875rem; margin-bottom: 20px; }
  .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px 18px; margin-bottom: 16px; }
  label { display: block; font-size: 0.75rem; font-weight: 600; color: #475569; margin: 10px 0 4px; text-transform: uppercase; letter-spacing: .04em; }
  select, input[type=text], input[type=number] { width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 0.95rem; background: #fff; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .check { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
  .check input { width: auto; }
  button { margin-top: 14px; margin-right: 8px; padding: 8px 14px; border-radius: 8px; border: 1px solid #0f172a; background: #0f172a; color: #fff; font-weight: 600; cursor: pointer; }
  button.secondary { background: #fff; color: #0f172a; }
  pre { background: #0f172a; color: #e2e8f0; padding: 12px; border-radius: 8px; overflow: auto; font-size: 0.8rem; }
  .ok { color: #15803d; font-weight: 600; }
  .bad { color: #b91c1c; font-weight: 600; }
  .ledger { font-family: ui-monospace, monospace; font-size: 0.8rem; line-height: 1.5; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; background: #e2e8f0; margin: 2px; font-size: 0.75rem; }
  .pill.dep { background: #fef3c7; }
  .pill.off { background: #fee2e2; }
  .pill.on { background: #dcfce7; }
  #fields .field-note { font-size: 0.75rem; color: #64748b; }
</style>
</head>
<body>
  <h1>OAR create-agent form (schema-driven demo)</h1>
  <p class="sub">Offline single file · schema baked from oar fixtures · registry ledger must close at 12 · no network</p>

  <div class="card">
    <strong>Registry ledger</strong>
    <div class="ledger" id="ledger"></div>
  </div>

  <div class="card">
    <div id="form"></div>
    <button type="button" id="btn-validate">Validate (oar rules in-browser)</button>
    <button type="button" class="secondary" id="btn-reject">Load known-reject sample</button>
    <button type="button" class="secondary" id="btn-valid">Load valid codex sample</button>
    <div id="result" style="margin-top:12px"></div>
  </div>

  <div class="card">
    <strong>Effective fields (after if/then)</strong>
    <pre id="effective"></pre>
  </div>

  <div class="card">
    <strong>Submission JSON</strong>
    <pre id="json"></pre>
  </div>

<script>
const DATA = ${dataJson};

// --- minimal effectiveSchema (mirrors oar profile.effectiveSchema) ---
function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function matches(ifSchema, value) {
  if (ifSchema === false) return false;
  for (const key of ifSchema.required || []) {
    if (!(key in value)) return false;
  }
  for (const [k, c] of Object.entries(ifSchema.properties || {})) {
    if (!(k in value)) return false;
    if (c !== false) {
      if ("const" in c && value[k] !== c.const) return false;
      if (c.enum !== undefined && !c.enum.includes(value[k])) return false;
    }
  }
  return true;
}
function effectiveSchema(schema, value) {
  if (schema === false) return { properties: {}, required: [] };
  const props = { ...(schema.properties || {}) };
  const required = new Set(schema.required || []);
  for (const branch of schema.allOf || []) {
    if (matches(branch.if, value)) {
      const sub = effectiveSchema(branch.then, value);
      Object.assign(props, sub.properties);
      for (const r of sub.required) required.add(r);
    }
  }
  return { properties: props, required: [...required] };
}

function labelFor(kind, id, runtime, provider) {
  const L = DATA.labels || {};
  if (kind === "runtime") return L["runtime:" + id] || id;
  if (kind === "provider") return L["provider:" + runtime + ":" + id] || id;
  if (kind === "model") {
    return L["model:" + runtime + ":" + (provider ? provider + ":" : "") + id]
      || L["model:" + runtime + ":" + id]
      || id;
  }
  if (kind === "option") return L["option:" + id] || id;
  if (kind === "choice") return L["choice:" + arguments[4] + ":" + id] || id;
  return id;
}

const state = {
  runtime: "",
  provider: "",
  model: "",
  authMode: "ambient",
  credentialRef: "",
  options: {},
};

function renderLedger() {
  const offer = new Set(DATA.creatable);
  const dep = new Set(DATA.deprecated);
  const unavail = new Set((DATA.unavailable || []).map(u => u.runtime));
  const all = DATA.registry;
  let html = "registry=" + all.length + " · creatable=" + offer.size
    + " · deprecated=" + dep.size + " · unavailable=" + unavail.size + "<br/>";
  const union = new Set([...offer, ...dep, ...unavail]);
  const ok = union.size === all.length && all.every(id => union.has(id));
  html += (ok ? '<span class="ok">LEDGER CLOSED @ 12</span>' : '<span class="bad">LEDGER OPEN — mismatch</span>') + "<br/><br/>";
  for (const id of all) {
    let cls = "pill";
    let tag = id;
    if (dep.has(id)) { cls += " dep"; tag += " (deprecated, excluded from create)"; }
    else if (unavail.has(id)) { cls += " off"; tag += " (unavailable)"; }
    else if (offer.has(id)) { cls += " on"; tag += " (create)"; }
    else { cls += " off"; tag += " (MISSING FROM LEDGER ARMS)"; }
    html += '<span class="' + cls + '">' + tag + "</span>";
  }
  document.getElementById("ledger").innerHTML = html;
}

function currentValue() {
  const v = {
    runtime: state.runtime,
    auth: { mode: state.authMode },
  };
  if (state.authMode !== "ambient" && state.credentialRef) {
    v.auth.credential = { ref: state.credentialRef };
  }
  if (state.provider) v.provider = state.provider;
  if (state.model) v.model = state.model;
  for (const [k, val] of Object.entries(state.options)) {
    if (val !== "" && val !== undefined) v[k] = val;
  }
  return v;
}

function renderForm() {
  const schema = DATA.schema;
  const value = currentValue();
  const eff = effectiveSchema(schema, value);
  const props = eff.properties;
  const required = new Set(eff.required);

  let html = "";

  // runtime
  const rt = props.runtime;
  const rtEnum = rt && rt !== false ? (rt.enum || []) : [];
  html += "<label>Runtime</label><select id=\"f-runtime\">";
  html += '<option value="">— select —</option>';
  for (const id of rtEnum) {
    const sel = state.runtime === id ? " selected" : "";
    html += '<option value="' + id + '"' + sel + ">" + labelFor("runtime", id) + " (" + id + ")</option>";
  }
  html += "</select>";

  // provider
  if (props.provider && props.provider !== false && props.provider.enum) {
    html += "<label>Provider</label><select id=\"f-provider\">";
    html += '<option value="">— select —</option>';
    for (const id of props.provider.enum) {
      const sel = state.provider === id ? " selected" : "";
      html += '<option value="' + id + '"' + sel + ">" + labelFor("provider", id, state.runtime) + "</option>";
    }
    html += "</select>";
  }

  // model
  if (props.model && props.model !== false && props.model.enum) {
    html += "<label>Model</label><select id=\"f-model\">";
    html += '<option value="">— select —</option>';
    for (const id of props.model.enum) {
      const sel = state.model === id ? " selected" : "";
      html += '<option value="' + id + '"' + sel + ">" + labelFor("model", id, state.runtime, state.provider) + "</option>";
    }
    html += "</select>";
    html += '<p class="field-note">Reverse-narrow check: only models for the selected runtime/provider appear.</p>';
  }

  // auth
  html += "<label>Auth mode</label><select id=\"f-auth\">";
  for (const m of ["ambient", "explicit_key", "delegated", "gateway"]) {
    html += '<option value="' + m + '"' + (state.authMode === m ? " selected" : "") + ">" + m + "</option>";
  }
  html += "</select>";
  if (state.authMode !== "ambient") {
    html += "<label>Credential ref</label><input type=\"text\" id=\"f-cred\" value=\"" + (state.credentialRef || "") + "\" placeholder=\"cred:…\"/>";
  }

  // options
  html += '<div id="fields">';
  for (const [key, p] of Object.entries(props)) {
    if (["runtime", "provider", "model", "auth", "env"].includes(key)) continue;
    if (p === false) continue;
    const req = required.has(key) ? " *" : "";
    html += "<label>" + labelFor("option", key) + req + "</label>";
    if (p.type === "boolean") {
      const checked = state.options[key] === true ? " checked" : "";
      html += '<div class="check"><input type="checkbox" id="opt-' + key + '"' + checked + "/> <span>true</span></div>";
    } else if (p.enum) {
      html += '<select id="opt-' + key + '"><option value="">—</option>';
      for (const id of p.enum) {
        const sel = state.options[key] === id ? " selected" : "";
        html += '<option value="' + id + '"' + sel + ">" + (DATA.labels["choice:" + key + ":" + id] || id) + "</option>";
      }
      html += "</select>";
    } else if (p.type === "number") {
      html += '<input type="number" id="opt-' + key + '" value="' + (state.options[key] ?? "") + '"/>';
    } else {
      html += '<input type="text" id="opt-' + key + '" value="' + (state.options[key] ?? "") + '"/>';
    }
  }
  html += "</div>";

  document.getElementById("form").innerHTML = html;
  document.getElementById("json").textContent = JSON.stringify(value, null, 2);
  document.getElementById("effective").textContent = JSON.stringify({
    required: [...required],
    propertyKeys: Object.keys(props).filter(k => props[k] !== false),
    modelEnum: props.model && props.model !== false ? props.model.enum : null,
    providerEnum: props.provider && props.provider !== false ? props.provider.enum : null,
  }, null, 2);

  bind();
}

function bind() {
  const rt = document.getElementById("f-runtime");
  if (rt) rt.onchange = () => {
    state.runtime = rt.value;
    state.provider = "";
    state.model = "";
    state.options = {};
    renderForm();
  };
  const pr = document.getElementById("f-provider");
  if (pr) pr.onchange = () => {
    state.provider = pr.value;
    state.model = "";
    state.options = {};
    renderForm();
  };
  const md = document.getElementById("f-model");
  if (md) md.onchange = () => {
    state.model = md.value;
    state.options = {};
    renderForm();
  };
  const au = document.getElementById("f-auth");
  if (au) au.onchange = () => {
    state.authMode = au.value;
    renderForm();
  };
  const cr = document.getElementById("f-cred");
  if (cr) cr.oninput = () => { state.credentialRef = cr.value; syncJson(); };
  for (const el of document.querySelectorAll("[id^=opt-]")) {
    const key = el.id.slice(4);
    el.onchange = el.oninput = () => {
      if (el.type === "checkbox") state.options[key] = el.checked;
      else if (el.type === "number") state.options[key] = el.value === "" ? "" : Number(el.value);
      else state.options[key] = el.value;
      syncJson();
    };
  }
}

function syncJson() {
  const value = currentValue();
  document.getElementById("json").textContent = JSON.stringify(value, null, 2);
}

// Browser-side checkAgainstProfile (subset sufficient for demo)
function checkObject(schema, value, fieldPrefix) {
  if (schema === false) throw new Error("unsupported_option: " + fieldPrefix);
  if (!isPlainObject(value)) throw new Error("malformed: " + fieldPrefix);
  const eff = effectiveSchema(schema, value);
  for (const r of eff.required) {
    if (!(r in value)) throw new Error("missing_required: " + r);
  }
  for (const [k, p] of Object.entries(eff.properties)) {
    if (!(k in value)) continue;
    if (p === false) throw new Error("unsupported_option: " + k);
    const v = value[k];
    if (p.type === "object" || (p.properties || p.allOf)) {
      checkObject(p, v, k);
      continue;
    }
    if (p.enum && !p.enum.includes(v)) throw new Error("value_not_allowed: " + k);
    if (p.const !== undefined && v !== p.const) throw new Error("value_not_allowed: " + k);
    if (p.type === "boolean" && typeof v !== "boolean") throw new Error("malformed: " + k);
    if (p.type === "string" && typeof v !== "string") throw new Error("malformed: " + k);
    if (p.type === "number" && typeof v !== "number") throw new Error("malformed: " + k);
  }
  // extra keys that are not in effective props (except we allow only known)
  for (const k of Object.keys(value)) {
    if (k === "env") continue;
    if (!(k in eff.properties) && !["runtime","model","provider","auth"].includes(k)) {
      // option not in effective set
      if (!eff.properties[k]) {
        // if it was an option field not currently effective
        if (!["runtime","model","provider","auth"].includes(k)) {
          throw new Error("unsupported_option: " + k);
        }
      }
    }
  }
}

function validateBrowser() {
  const value = currentValue();
  const el = document.getElementById("result");
  try {
    if (value.auth && value.auth.mode === "ambient" && value.auth.credential) {
      throw new Error("unsupported_option: auth.credential");
    }
    checkObject(DATA.schema, value, "");
    el.innerHTML = '<span class="ok">PASS</span> <pre>' + JSON.stringify(value, null, 2) + "</pre>";
  } catch (e) {
    el.innerHTML = '<span class="bad">REJECT ' + e.message + "</span>";
  }
}

document.getElementById("btn-validate").onclick = validateBrowser;
document.getElementById("btn-reject").onclick = () => {
  const s = DATA.samples.rejected;
  state.runtime = s.body.runtime;
  state.model = s.body.model;
  state.provider = "";
  state.authMode = s.body.auth.mode;
  state.options = { reasoningEffort: s.body.reasoningEffort };
  renderForm();
  document.getElementById("result").innerHTML =
    '<span class="bad">Precomputed oar validateConfig REJECT: ' + s.error + "</span>"
    + "<pre>" + JSON.stringify(s.body, null, 2) + "</pre>";
};
document.getElementById("btn-valid").onclick = () => {
  const s = DATA.samples.valid;
  state.runtime = s.body.runtime;
  state.model = s.body.model;
  state.provider = "";
  state.authMode = s.body.auth.mode;
  state.options = { reasoningEffort: s.body.reasoningEffort, fastMode: s.body.fastMode };
  renderForm();
  document.getElementById("result").innerHTML =
    '<span class="ok">Precomputed oar validateConfig PASS</span>'
    + "<pre>" + JSON.stringify(s.result, null, 2) + "</pre>";
};

renderLedger();
// default select first runtime for nicer first paint
state.runtime = DATA.creatable[0] || "";
renderForm();
</script>
</body>
</html>
`;

const outHtml = join(root, "artifacts-local", "create-agent-form-demo.html");
writeFileSync(outHtml, html);
console.log("wrote", outJson);
console.log("wrote", outHtml);
console.log("snapshotId", baked.snapshotId);
console.log("creatable", creatable.map((d) => d.runtime).join(","));
console.log("deprecated", deprecated.map((d) => d.runtime).join(","));
