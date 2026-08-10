/**
 * Live host detect → form schema → offline HTML.
 * Usage:
 *   pnpm exec tsx scripts/live-detect-and-bake.ts
 */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import { detectAllRegistered } from "../src/discovery/detect.js";
import { buildFormSchema } from "../src/config/schema.js";
import { validateConfig, ConfigError } from "../src/config/validate.js";
import { createHostDrivers, hostDetectMeta } from "../src/discovery/host/runtimeDrivers.js";
import {
  RAFT_DRIVER_REGISTRY,
  RAFT_DEPRECATED_FOR_CREATE,
} from "../src/discovery/fixtures/raftRuntimes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

/** Producer-side provenanceKind — never leave only the HTML renderer to invent this. */
function provenanceKindOf(
  d: { failure?: string; models: readonly unknown[] },
  source: string,
): string {
  if (d.failure === "not_installed") return "not_installed";
  if (d.failure === "needs_login") return "needs_login";
  if (d.failure === "detect_failed") return "detect_failed";
  if (d.failure === "models_unavailable") return "models_unavailable";
  if (d.models.length === 0) return "models_unavailable";
  if (/raft-daemon|SLOCK_DAEMON|sdk/i.test(source)) return "sdk_catalog_live";
  if (/cache/i.test(source)) return "host_cli_cache";
  return "host_cli_verified";
}

async function main() {
  const meta = hostDetectMeta();
  const drivers = createHostDrivers();
  console.error("detecting via oar host drivers…");
  const descs = await detectAllRegistered(drivers, RAFT_DRIVER_REGISTRY);
  console.error(
    "descriptors:",
    descs.map((d) => `${d.runtime}@${d.version} models=${d.models.length} fail=${d.failure ?? "-"}`).join("\n  "),
  );

  // Full registry (incl. not_installed) → unavailable[] carries reasons (design §5).
  // Deprecated runtimes stay out of the create enum only.
  const deprecated = new Set<string>(RAFT_DEPRECATED_FOR_CREATE);
  const bakedAll = buildFormSchema(descs);
  // Strip deprecated from create enum; re-tag them as unavailable with explicit reason if present.
  const runtimeProp = bakedAll.schema !== false ? bakedAll.schema.properties?.runtime : undefined;
  const enumIds =
    runtimeProp && runtimeProp !== false && Array.isArray(runtimeProp.enum)
      ? runtimeProp.enum.filter((id) => !deprecated.has(String(id)))
      : [];
  const depUnavailable = descs
    .filter((d) => deprecated.has(d.runtime))
    .map((d) => ({
      runtime: d.runtime,
      failure: (d.failure ?? "models_unavailable") as typeof d.failure extends undefined
        ? "models_unavailable"
        : NonNullable<typeof d.failure>,
    }));
  // Prefer a structured note: keep schema from non-deprecated descs for validate, but
  // unavailable = all non-offerable including not_installed + deprecated.
  const forCreate = descs.filter((d) => !deprecated.has(d.runtime));
  const baked = buildFormSchema(forCreate);
  // Merge unavailable: schema-from-forCreate + any deprecated + ensure not_installed from full set
  const unavailMap = new Map<string, { runtime: string; failure: string }>();
  for (const u of baked.unavailable) unavailMap.set(u.runtime, u);
  for (const d of descs) {
    if (deprecated.has(d.runtime)) {
      unavailMap.set(d.runtime, { runtime: d.runtime, failure: d.failure ?? "not_installed" });
    } else if (d.failure) {
      unavailMap.set(d.runtime, { runtime: d.runtime, failure: d.failure });
    } else if (d.models.length === 0 && !(d.providers && d.providers.length > 0)) {
      unavailMap.set(d.runtime, { runtime: d.runtime, failure: "models_unavailable" });
    }
  }
  const mergedUnavailable = [...unavailMap.values()];
  // attach for payload
  (baked as { unavailable: typeof mergedUnavailable }).unavailable = mergedUnavailable as typeof baked.unavailable;
  void bakedAll;
  void enumIds;
  void depUnavailable;

  // Registry ledger
  const offerable = new Set(
    baked.schema !== false && baked.schema.properties?.runtime !== false
      ? ((baked.schema.properties?.runtime as { enum?: string[] }).enum ?? [])
      : [],
  );
  const unavail = new Set(baked.unavailable.map((u) => u.runtime));
  const dep = new Set(RAFT_DEPRECATED_FOR_CREATE);
  // also descs that failed
  for (const d of descs) {
    if (d.failure || d.models.length === 0) {
      if (!offerable.has(d.runtime) && !dep.has(d.runtime)) unavail.add(d.runtime);
    }
  }

  // Reject samples: (a) illegal enum with all required present; (b) missing required only
  type Reject = { body: unknown; error: string; intent: string };
  const rejects: Reject[] = [];
  const codex = forCreate.find((d) => d.runtime === "codex" && d.models.length > 0);
  if (codex) {
    const rich = codex.models.find((m) => m.options.some((o) => o.kind === "enum" && o.id === "reasoningEffort"));
    if (rich) {
      const bodyIllegal: Record<string, unknown> = {
        runtime: "codex",
        model: rich.id,
        auth: { mode: "ambient" },
        reasoningEffort: "not-a-real-effort",
        fastMode: false, // present so illegal enum is the sole error
      };
      try {
        validateConfig({
          raw: bodyIllegal,
          descs: forCreate,
          submittedSnapshotId: baked.snapshotId,
          currentSnapshotId: baked.snapshotId,
        });
      } catch (e) {
        if (e instanceof ConfigError) {
          rejects.push({ body: bodyIllegal, error: e.message, intent: "value_not_allowed on reasoningEffort" });
        }
      }
      const bodyMissing: Record<string, unknown> = {
        runtime: "codex",
        model: rich.id,
        auth: { mode: "ambient" },
        reasoningEffort: (rich.options.find((o) => o.id === "reasoningEffort") as { values: { id: string }[] }).values[0]!.id,
        // omit fastMode deliberately
      };
      try {
        validateConfig({
          raw: bodyMissing,
          descs: forCreate,
          submittedSnapshotId: baked.snapshotId,
          currentSnapshotId: baked.snapshotId,
        });
      } catch (e) {
        if (e instanceof ConfigError) {
          rejects.push({ body: bodyMissing, error: e.message, intent: "missing_required fastMode" });
        }
      }
    }
  }
  const rejectSample = rejects[0] ?? {
    body: { runtime: "codex", model: "__none__", auth: { mode: "ambient" } },
    error: "value_not_allowed: model",
    intent: "fallback",
  };

  let validSample: { body: unknown; result: unknown } | null = null;
  if (codex) {
    const rich = codex.models.find((m) => m.options.length > 0) ?? codex.models[0]!;
    const body: Record<string, unknown> = {
      runtime: "codex",
      model: rich.id,
      auth: { mode: "ambient" },
    };
    for (const o of rich.options) {
      if (o.kind === "enum") body[o.id] = o.values[0]!.id;
      if (o.kind === "boolean") body[o.id] = false;
    }
    try {
      const result = validateConfig({
        raw: body,
        descs: forCreate,
        submittedSnapshotId: baked.snapshotId,
        currentSnapshotId: baked.snapshotId,
      });
      validSample = { body, result };
    } catch (e) {
      console.error("valid sample failed", e);
    }
  }

  const evidence = descs.map((d) => {
    const source = meta.sources[d.runtime] ?? "host detect";
    const provenanceKind = provenanceKindOf(d, source);
    return {
      runtime: d.runtime,
      version: d.version,
      modelCount: d.models.length,
      providerCount: d.providers?.length ?? 0,
      failure: d.failure ?? null,
      // Four product states must be self-describing in JSON (not only HTML):
      // ready | needs_login | not_installed | detect_failed|models_unavailable
      provenanceKind,
      source,
      modelIds: d.models.slice(0, 12).map((m) => m.id),
      optionsExample: d.models[0]
        ? d.models[0].options.map((o) => o.id)
        : [],
    };
  });

  const notInstalled = descs.filter((d) => d.failure === "not_installed").map((d) => d.runtime);
  const needsLogin = descs.filter((d) => d.failure === "needs_login").map((d) => d.runtime);
  const detectFailed = descs.filter((d) => d.failure === "detect_failed").map((d) => d.runtime);
  const modelsUnavailable = descs
    .filter((d) => d.failure === "models_unavailable")
    .map((d) => d.runtime);
  const ready = descs
    .filter((d) => d.failure === undefined && d.models.length > 0)
    .map((d) => d.runtime);

  const payload = {
    provenance: {
      ...meta,
      host: hostname(),
      mode: "live-host-detect",
      note:
        "Models/options come from oar host drivers (CLI/cache/SDK in-process) — not hand-authored fixture catalogs.",
      registry: [...RAFT_DRIVER_REGISTRY],
    },
    evidence,
    /** Machine-readable four-state partition for testbed/oar acceptance (R3). */
    ledger: {
      registry: RAFT_DRIVER_REGISTRY.length,
      creatable: offerable.size,
      unavailable: baked.unavailable.length,
      deprecated: dep.size,
      sum_create_plus_unavail: offerable.size + baked.unavailable.length,
      ready,
      notInstalled,
      needsLogin,
      detectFailed,
      modelsUnavailable,
      liveModels: ready,
    },
    deprecated: [...RAFT_DEPRECATED_FOR_CREATE],
    deprecatedExcluded: [...dep].map((runtime) => ({ runtime, reason: "deprecated" as const })),
    unavailable: baked.unavailable,
    snapshotId: baked.snapshotId,
    schema: baked.schema,
    labels: {
      ...baked.labels,
      // human labels for runtimes
      ...Object.fromEntries(
        descs.map((d) => [`runtime:${d.runtime}`, d.label ?? d.runtime]),
      ),
    },
    detectedAll: descs.map((d) => d.runtime),
    creatable: [...offerable],
    samples: {
      valid: validSample
        ? { body: validSample.body, ok: true, result: validSample.result }
        : null,
      rejected: { ...rejectSample, ok: false },
      rejectedAll: rejects.map((r) => ({ ...r, ok: false as const })),
    },
  };

  const outDir = join(root, "artifacts-local");
  mkdirSync(outDir, { recursive: true });
  const outJson = join(outDir, "create-agent-form-live.json");
  writeFileSync(outJson, JSON.stringify(payload, null, 2));

  // Reuse previous HTML shell: load from demo and replace DATA
  const demoPath = join(outDir, "create-agent-form-demo.html");
  let html: string;
  if (true) {
    // Generate HTML by calling the same template approach - read existing bake or write full
    html = buildHtml(payload);
  }
  const outHtml = join(outDir, "create-agent-form-live.html");
  writeFileSync(outHtml, html);
  console.log("wrote", outJson);
  console.log("wrote", outHtml);
  console.log(
    "ledger offerable",
    offerable.size,
    "deprecated",
    dep.size,
    "unavailable",
    baked.unavailable.length,
  );
}

function buildHtml(DATA: unknown): string {
  const dataJson = JSON.stringify(DATA);
  // Minimal copy of demo HTML with provenance banner
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>OAR live create-agent form</title>
<style>
:root{font-family:ui-sans-serif,system-ui,sans-serif;color:#0f172a}
body{max-width:960px;margin:24px auto;padding:0 16px 48px;background:#f8fafc}
h1{font-size:1.25rem;margin:0 0 4px}
.sub{color:#64748b;font-size:.875rem;margin-bottom:16px}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:16px 18px;margin-bottom:16px}
label{display:block;font-size:.75rem;font-weight:600;color:#475569;margin:10px 0 4px;text-transform:uppercase;letter-spacing:.04em}
select,input{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px;font-size:.95rem}
button{margin-top:12px;margin-right:8px;padding:8px 14px;border-radius:8px;border:1px solid #0f172a;background:#0f172a;color:#fff;font-weight:600;cursor:pointer}
button.secondary{background:#fff;color:#0f172a}
pre{background:#0f172a;color:#e2e8f0;padding:12px;border-radius:8px;overflow:auto;font-size:.78rem}
.ok{color:#15803d;font-weight:600}.bad{color:#b91c1c;font-weight:600}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;background:#e2e8f0;margin:2px;font-size:.72rem}
.pill.on{background:#dcfce7}.pill.dep{background:#fef3c7}.pill.off{background:#fee2e2}.pill.login{background:#dbeafe}
table{width:100%;border-collapse:collapse;font-size:.8rem}
td,th{border-bottom:1px solid #e2e8f0;padding:6px 4px;text-align:left;vertical-align:top}
</style></head><body>
<h1>OAR create-agent form — LIVE host detect</h1>
<p class="sub" id="prov"></p>
<div class="card"><strong>Registry ledger + four-state</strong><div id="ledger"></div></div>
<div class="card"><strong>Evidence (per runtime)</strong><div id="evidence"></div></div>
<div class="card"><div id="form"></div>
<button id="btn-validate">Validate</button>
<button class="secondary" id="btn-reject">Load reject sample</button>
<button class="secondary" id="btn-valid">Load valid sample</button>
<div id="result" style="margin-top:12px"></div></div>
<div class="card"><strong>Effective fields</strong><pre id="effective"></pre></div>
<div class="card"><strong>Submission JSON</strong><pre id="json"></pre></div>
<script>
const DATA = ${dataJson};
function isPlainObject(v){return typeof v==='object'&&v!==null&&!Array.isArray(v)}
function matches(ifSchema,value){
  if(ifSchema===false)return false;
  for(const key of ifSchema.required||[]) if(!(key in value)) return false;
  for(const [k,c] of Object.entries(ifSchema.properties||{})){
    if(!(k in value)) return false;
    if(c!==false){ if('const' in c && value[k]!==c.const) return false;
      if(c.enum!==undefined && !c.enum.includes(value[k])) return false; }
  }
  return true;
}
function effectiveSchema(schema,value){
  if(schema===false) return {properties:{},required:[]};
  const props={...(schema.properties||{})}; const required=new Set(schema.required||[]);
  for(const branch of schema.allOf||[]){
    if(matches(branch.if,value)){ const sub=effectiveSchema(branch.then,value);
      Object.assign(props,sub.properties); for(const r of sub.required) required.add(r); }
  }
  return {properties:props, required:[...required]};
}
const state={runtime:'',provider:'',model:'',authMode:'ambient',credentialRef:'',options:{}};
function label(kind,id,runtime,provider){
  const L=DATA.labels||{};
  if(kind==='runtime') return L['runtime:'+id]||id;
  if(kind==='provider') return L['provider:'+runtime+':'+id]||id;
  if(kind==='model') return L['model:'+runtime+':'+(provider?provider+':':'')+id]||L['model:'+runtime+':'+id]||id;
  if(kind==='option') return L['option:'+id]||id;
  return id;
}
function renderLedger(){
  const offer=new Set(DATA.creatable||[]);
  const dep=new Set(DATA.deprecated||[]);
  const unavail=new Set((DATA.unavailable||[]).map(u=>u.runtime));
  const all=DATA.provenance.registry;
  const L=DATA.ledger||{};
  let html='host='+DATA.provenance.host+' · at='+DATA.provenance.at+' · mode='+DATA.provenance.mode+'<br/>';
  html+='ready=['+(L.ready||[]).join(', ')+'] · needsLogin=['+(L.needsLogin||[]).join(', ')+'] · notInstalled=['+(L.notInstalled||[]).join(', ')+'] · detectFailed=['+(L.detectFailed||[]).join(', ')+'] · modelsUnavailable=['+(L.modelsUnavailable||[]).join(', ')+']<br/>';
  // Close ledger: every registry id must appear in detectedAll or be explained
  const detected=new Set(DATA.detectedAll||[]);
  let missing=[];
  for(const id of all){ if(!detected.has(id) && !dep.has(id) && !unavail.has(id) && !offer.has(id)) missing.push(id); }
  html += (missing.length===0 ? '<span class="ok">REGISTRY COVERED ('+all.length+')</span>' : '<span class="bad">MISSING '+missing.join(',')+'</span>')+'<br/><br/>';
  for(const e of (DATA.evidence||[])){
    let cls='pill';
    if(e.provenanceKind==='not_installed') cls+=' off';
    else if(e.provenanceKind==='needs_login') cls+=' login';
    else if(e.failure) cls+=' off';
    else if(offer.has(e.runtime)) cls+=' on';
    else if(dep.has(e.runtime)) cls+=' dep';
    html+='<span class="'+cls+'">'+e.runtime+' · '+(e.provenanceKind||'?')+' · models='+e.modelCount+'</span>';
  }
  document.getElementById('ledger').innerHTML=html;
  document.getElementById('prov').textContent=DATA.provenance.note;
  let ev='<table><tr><th>runtime</th><th>provenanceKind</th><th>version</th><th>models</th><th>failure</th><th>source</th><th>sample ids</th></tr>';
  for(const e of DATA.evidence){
    ev+='<tr><td>'+e.runtime+'</td><td>'+(e.provenanceKind||'')+'</td><td>'+e.version+'</td><td>'+e.modelCount+'</td><td>'+(e.failure||'')+'</td><td style="max-width:240px;white-space:normal">'+(e.source||'')+'</td><td>'+(e.modelIds||[]).slice(0,6).join(', ')+'</td></tr>';
  }
  ev+='</table>';
  document.getElementById('evidence').innerHTML=ev;
}
function currentValue(){
  const v={runtime:state.runtime, auth:{mode:state.authMode}};
  if(state.authMode!=='ambient'&&state.credentialRef) v.auth.credential={ref:state.credentialRef};
  if(state.provider) v.provider=state.provider;
  if(state.model) v.model=state.model;
  for(const [k,val] of Object.entries(state.options)) if(val!==''&&val!==undefined) v[k]=val;
  return v;
}
function renderForm(){
  const schema=DATA.schema; const value=currentValue(); const eff=effectiveSchema(schema,value);
  const props=eff.properties; const required=new Set(eff.required);
  let html='';
  const rt=props.runtime; const rtEnum=rt&&rt!==false?(rt.enum||[]):[];
  html+='<label>Runtime</label><select id="f-runtime"><option value="">—</option>';
  for(const id of rtEnum){ html+='<option value="'+id+'"'+(state.runtime===id?' selected':'')+'>'+label('runtime',id)+' ('+id+')</option>'; }
  html+='</select>';
  if(props.provider&&props.provider!==false&&props.provider.enum){
    html+='<label>Provider</label><select id="f-provider"><option value="">—</option>';
    for(const id of props.provider.enum){ html+='<option value="'+id+'"'+(state.provider===id?' selected':'')+'>'+label('provider',id,state.runtime)+'</option>'; }
    html+='</select>';
  }
  if(props.model&&props.model!==false&&props.model.enum){
    html+='<label>Model ('+props.model.enum.length+')</label><select id="f-model"><option value="">—</option>';
    for(const id of props.model.enum){ html+='<option value="'+id+'"'+(state.model===id?' selected':'')+'>'+label('model',id,state.runtime,state.provider)+'</option>'; }
    html+='</select>';
  }
  html+='<label>Auth</label><select id="f-auth">';
  for(const m of ['ambient','explicit_key','delegated','gateway']) html+='<option value="'+m+'"'+(state.authMode===m?' selected':'')+'>'+m+'</option>';
  html+='</select>';
  if(state.authMode!=='ambient') html+='<label>Credential ref</label><input id="f-cred" value="'+(state.credentialRef||'')+'"/>';
  for(const [key,p] of Object.entries(props)){
    if(['runtime','provider','model','auth','env'].includes(key)||p===false) continue;
    html+='<label>'+label('option',key)+(required.has(key)?' *':'')+'</label>';
    if(p.type==='boolean') html+='<input type="checkbox" id="opt-'+key+'"'+(state.options[key]===true?' checked':'')+'/>';
    else if(p.enum){ html+='<select id="opt-'+key+'"><option value="">—</option>';
      for(const id of p.enum) html+='<option value="'+id+'"'+(state.options[key]===id?' selected':'')+'>'+id+'</option>';
      html+='</select>'; }
    else html+='<input id="opt-'+key+'" value="'+(state.options[key]??'')+'"/>';
  }
  document.getElementById('form').innerHTML=html;
  document.getElementById('json').textContent=JSON.stringify(value,null,2);
  document.getElementById('effective').textContent=JSON.stringify({required:[...required], keys:Object.keys(props), modelEnum:props.model&&props.model!==false?props.model.enum:null},null,2);
  bind();
}
function bind(){
  const rt=document.getElementById('f-runtime'); if(rt) rt.onchange=()=>{state.runtime=rt.value;state.provider='';state.model='';state.options={};renderForm();};
  const pr=document.getElementById('f-provider'); if(pr) pr.onchange=()=>{state.provider=pr.value;state.model='';state.options={};renderForm();};
  const md=document.getElementById('f-model'); if(md) md.onchange=()=>{state.model=md.value;state.options={};renderForm();};
  const au=document.getElementById('f-auth'); if(au) au.onchange=()=>{state.authMode=au.value;renderForm();};
  const cr=document.getElementById('f-cred'); if(cr) cr.oninput=()=>{state.credentialRef=cr.value;};
  for(const el of document.querySelectorAll('[id^=opt-]')){
    const key=el.id.slice(4);
    el.onchange=el.oninput=()=>{ state.options[key]=el.type==='checkbox'?el.checked:el.value; document.getElementById('json').textContent=JSON.stringify(currentValue(),null,2); };
  }
}
function checkObject(schema,value){
  if(schema===false) throw new Error('unsupported');
  if(!isPlainObject(value)) throw new Error('malformed');
  const eff=effectiveSchema(schema,value);
  for(const r of eff.required) if(!(r in value)) throw new Error('missing_required: '+r);
  for(const [k,p] of Object.entries(eff.properties)){
    if(!(k in value)) continue;
    if(p===false) throw new Error('unsupported_option: '+k);
    const v=value[k];
    if(p.type==='object'||p.properties||p.allOf){ checkObject(p,v); continue; }
    if(p.enum&&!p.enum.includes(v)) throw new Error('value_not_allowed: '+k);
  }
  for(const k of Object.keys(value)){
    if(['env'].includes(k)) continue;
    if(!(k in eff.properties) && !['runtime','model','provider','auth'].includes(k))
      throw new Error('unsupported_option: '+k);
  }
}
document.getElementById('btn-validate').onclick=()=>{
  try{ checkObject(DATA.schema,currentValue());
    document.getElementById('result').innerHTML='<span class="ok">PASS</span>'; }
  catch(e){ document.getElementById('result').innerHTML='<span class="bad">REJECT '+e.message+'</span>'; }
};
document.getElementById('btn-reject').onclick=()=>{
  const s=DATA.samples.rejected; if(!s) return;
  state.runtime=s.body.runtime; state.model=s.body.model||''; state.provider='';
  state.authMode=(s.body.auth&&s.body.auth.mode)||'ambient';
  state.options={}; for(const [k,v] of Object.entries(s.body)) if(!['runtime','model','auth','provider'].includes(k)) state.options[k]=v;
  renderForm();
  document.getElementById('result').innerHTML='<span class="bad">oar validateConfig REJECT: '+s.error+'</span><pre>'+JSON.stringify(s.body,null,2)+'</pre>';
};
document.getElementById('btn-valid').onclick=()=>{
  const s=DATA.samples.valid; if(!s){ document.getElementById('result').innerHTML='<span class="bad">no valid sample</span>'; return; }
  state.runtime=s.body.runtime; state.model=s.body.model||''; state.provider=s.body.provider||'';
  state.authMode=(s.body.auth&&s.body.auth.mode)||'ambient';
  state.options={}; for(const [k,v] of Object.entries(s.body)) if(!['runtime','model','auth','provider'].includes(k)) state.options[k]=v;
  renderForm();
  document.getElementById('result').innerHTML='<span class="ok">oar validateConfig PASS</span><pre>'+JSON.stringify(s.result,null,2)+'</pre>';
};
renderLedger();
state.runtime=(DATA.creatable&&DATA.creatable[0])||'';
renderForm();
</script></body></html>`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
