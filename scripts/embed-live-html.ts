import { readFileSync, writeFileSync } from "node:fs";

const data = JSON.parse(readFileSync("artifacts-local/create-agent-form-live.json", "utf8"));
const dataJson = JSON.stringify(data);
const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>OAR live create-agent form</title>
<style>
:root{font-family:ui-sans-serif,system-ui,sans-serif;color:#0f172a}
body{max-width:980px;margin:24px auto;padding:0 16px 48px;background:#f8fafc}
h1{font-size:1.25rem;margin:0 0 4px}
.sub{color:#64748b;font-size:.875rem;margin-bottom:16px}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:16px 18px;margin-bottom:16px}
label{display:block;font-size:.75rem;font-weight:600;color:#475569;margin:10px 0 4px;text-transform:uppercase;letter-spacing:.04em}
select,input{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px}
button{margin-top:12px;margin-right:8px;padding:8px 14px;border-radius:8px;border:1px solid #0f172a;background:#0f172a;color:#fff;font-weight:600;cursor:pointer}
button.secondary{background:#fff;color:#0f172a}
pre{background:#0f172a;color:#e2e8f0;padding:12px;border-radius:8px;overflow:auto;font-size:.78rem}
.ok{color:#15803d;font-weight:600}.bad{color:#b91c1c;font-weight:600}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;background:#e2e8f0;margin:2px;font-size:.72rem}
.pill.on{background:#dcfce7}.pill.dep{background:#fef3c7}.pill.off{background:#fee2e2}.pill.login{background:#ffedd5}
table{width:100%;border-collapse:collapse;font-size:.78rem}
td,th{border-bottom:1px solid #e2e8f0;padding:6px 4px;text-align:left;vertical-align:top}
</style></head><body>
<h1>OAR create-agent form — LIVE host detect</h1>
<p class="sub" id="prov"></p>
<div class="card"><strong>Registry ledger + provenance</strong><div id="ledger"></div></div>
<div class="card"><strong>Evidence (no invented model lists)</strong><div id="evidence"></div></div>
<div class="card"><div id="form"></div>
<button id="btn-validate">Validate</button>
<button class="secondary" id="btn-reject">Load reject sample</button>
<button class="secondary" id="btn-valid">Load valid sample</button>
<div id="result" style="margin-top:12px"></div></div>
<div class="card"><strong>Effective fields</strong><pre id="effective"></pre></div>
<div class="card"><strong>Submission JSON</strong><pre id="json"></pre></div>
<script>
const DATA = ${dataJson};
function isPlainObject(v){return typeof v==="object"&&v!==null&&!Array.isArray(v)}
function matches(ifSchema,value){
  if(ifSchema===false)return false;
  for(const key of ifSchema.required||[]) if(!(key in value)) return false;
  for(const [k,c] of Object.entries(ifSchema.properties||{})){
    if(!(k in value)) return false;
    if(c!==false){ if("const" in c && value[k]!==c.const) return false;
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
const state={runtime:"",provider:"",model:"",authMode:"ambient",credentialRef:"",options:{}};
function label(kind,id,runtime,provider){
  const L=DATA.labels||{};
  if(kind==="runtime") return L["runtime:"+id]||id;
  if(kind==="model") return L["model:"+runtime+":"+(provider?provider+":":"")+id]||L["model:"+runtime+":"+id]||id;
  if(kind==="option") return L["option:"+id]||id;
  return id;
}
function renderLedger(){
  document.getElementById("prov").textContent=(DATA.provenance&&DATA.provenance.note)||"";
  const L=DATA.ledger||{};
  let html="host="+(DATA.provenance.host||"")+" · at="+(DATA.provenance.at||"")+" · liveModels=["+(L.liveModels||[]).join(", ")+"]<br/>";
  html+="notInstalled=["+(L.notInstalled||[]).join(", ")+"] · needsLogin=["+(L.needsLogin||[]).join(", ")+"] · deprecated=["+(DATA.deprecated||[]).join(", ")+"]<br/><br/>";
  for(const e of DATA.evidence||[]){
    let cls="pill";
    if(e.provenanceKind==="not_installed") cls+=" off";
    else if(e.provenanceKind==="needs_login") cls+=" login";
    else if(e.modelCount>0) cls+=" on";
    else if((DATA.deprecated||[]).includes(e.runtime)) cls+=" dep";
    html+='<span class="'+cls+'">'+e.runtime+" · "+(e.provenanceKind||"?")+" · models="+e.modelCount+"</span>";
  }
  document.getElementById("ledger").innerHTML=html;
  let ev="<table><tr><th>runtime</th><th>provenance</th><th>version</th><th>models</th><th>source</th><th>sample</th></tr>";
  for(const e of DATA.evidence||[]){
    ev+="<tr><td>"+e.runtime+"</td><td>"+(e.provenanceKind||"")+"</td><td>"+(e.version||"")+"</td><td>"+e.modelCount+"</td><td style=\\"max-width:280px;white-space:normal\\">"+(e.source||"")+"</td><td>"+(e.modelIds||[]).slice(0,5).join(", ")+"</td></tr>";
  }
  ev+="</table>";
  document.getElementById("evidence").innerHTML=ev;
}
function currentValue(){
  const v={runtime:state.runtime, auth:{mode:state.authMode}};
  if(state.authMode!=="ambient"&&state.credentialRef) v.auth.credential={ref:state.credentialRef};
  if(state.provider) v.provider=state.provider;
  if(state.model) v.model=state.model;
  for(const [k,val] of Object.entries(state.options)) if(val!==""&&val!==undefined) v[k]=val;
  return v;
}
function renderForm(){
  const schema=DATA.schema; const value=currentValue(); const eff=effectiveSchema(schema,value);
  const props=eff.properties; const required=new Set(eff.required);
  let html="";
  const rt=props.runtime; const rtEnum=rt&&rt!==false?(rt.enum||[]):[];
  html+='<label>Runtime (creatable with live models)</label><select id="f-runtime"><option value="">—</option>';
  for(const id of rtEnum){ html+='<option value="'+id+'"'+(state.runtime===id?" selected":"")+">"+label("runtime",id)+" ("+id+")</option>"; }
  html+="</select>";
  if(props.provider&&props.provider!==false&&props.provider.enum){
    html+='<label>Provider</label><select id="f-provider"><option value="">—</option>';
    for(const id of props.provider.enum){ html+='<option value="'+id+'"'+(state.provider===id?" selected":"")+">"+id+"</option>"; }
    html+="</select>";
  }
  if(props.model&&props.model!==false&&props.model.enum){
    html+='<label>Model ('+props.model.enum.length+')</label><select id="f-model"><option value="">—</option>';
    for(const id of props.model.enum){ html+='<option value="'+id+'"'+(state.model===id?" selected":"")+">"+label("model",id,state.runtime,state.provider)+"</option>"; }
    html+="</select>";
  }
  html+='<label>Auth</label><select id="f-auth">';
  for(const m of ["ambient","explicit_key","delegated","gateway"]) html+='<option value="'+m+'"'+(state.authMode===m?" selected":"")+">"+m+"</option>";
  html+="</select>";
  for(const [key,p] of Object.entries(props)){
    if(["runtime","provider","model","auth","env"].includes(key)||p===false) continue;
    html+="<label>"+label("option",key)+(required.has(key)?" *":"")+"</label>";
    if(p.type==="boolean") html+='<input type="checkbox" id="opt-'+key+'"'+(state.options[key]===true?" checked":"")+"/>";
    else if(p.enum){ html+='<select id="opt-'+key+'"><option value="">—</option>';
      for(const id of p.enum) html+='<option value="'+id+'"'+(state.options[key]===id?" selected":"")+">"+id+"</option>";
      html+="</select>"; }
    else html+='<input id="opt-'+key+'" value="'+(state.options[key]??"")+'"/>';
  }
  document.getElementById("form").innerHTML=html;
  document.getElementById("json").textContent=JSON.stringify(value,null,2);
  document.getElementById("effective").textContent=JSON.stringify({required:[...required],keys:Object.keys(props),modelEnum:props.model&&props.model!==false?props.model.enum:null},null,2);
  bind();
}
function bind(){
  const rt=document.getElementById("f-runtime"); if(rt) rt.onchange=()=>{state.runtime=rt.value;state.provider="";state.model="";state.options={};renderForm();};
  const pr=document.getElementById("f-provider"); if(pr) pr.onchange=()=>{state.provider=pr.value;state.model="";state.options={};renderForm();};
  const md=document.getElementById("f-model"); if(md) md.onchange=()=>{state.model=md.value;state.options={};renderForm();};
  const au=document.getElementById("f-auth"); if(au) au.onchange=()=>{state.authMode=au.value;renderForm();};
  for(const el of document.querySelectorAll("[id^=opt-]")){
    const key=el.id.slice(4);
    el.onchange=el.oninput=()=>{ state.options[key]=el.type==="checkbox"?el.checked:el.value; document.getElementById("json").textContent=JSON.stringify(currentValue(),null,2); };
  }
}
function checkObject(schema,value){
  if(schema===false) throw new Error("unsupported");
  if(!isPlainObject(value)) throw new Error("malformed");
  const eff=effectiveSchema(schema,value);
  for(const r of eff.required) if(!(r in value)) throw new Error("missing_required: "+r);
  for(const [k,p] of Object.entries(eff.properties)){
    if(!(k in value)) continue;
    if(p===false) throw new Error("unsupported_option: "+k);
    const v=value[k];
    if(p.type==="object"||p.properties||p.allOf){ checkObject(p,v); continue; }
    if(p.enum&&!p.enum.includes(v)) throw new Error("value_not_allowed: "+k);
  }
  for(const k of Object.keys(value)){
    if(k==="env") continue;
    if(!(k in eff.properties) && !["runtime","model","provider","auth"].includes(k))
      throw new Error("unsupported_option: "+k);
  }
}
document.getElementById("btn-validate").onclick=()=>{
  try{ checkObject(DATA.schema,currentValue()); document.getElementById("result").innerHTML='<span class="ok">PASS</span>'; }
  catch(e){ document.getElementById("result").innerHTML='<span class="bad">REJECT '+e.message+"</span>"; }
};
document.getElementById("btn-reject").onclick=()=>{
  const s=DATA.samples&&DATA.samples.rejected; if(!s) return;
  state.runtime=s.body.runtime; state.model=s.body.model||""; state.provider="";
  state.authMode=(s.body.auth&&s.body.auth.mode)||"ambient"; state.options={};
  for(const [k,v] of Object.entries(s.body)) if(!["runtime","model","auth","provider"].includes(k)) state.options[k]=v;
  renderForm();
  document.getElementById("result").innerHTML='<span class="bad">oar validateConfig REJECT: '+s.error+"</span><pre>"+JSON.stringify(s.body,null,2)+"</pre>";
};
document.getElementById("btn-valid").onclick=()=>{
  const s=DATA.samples&&DATA.samples.valid; if(!s){ document.getElementById("result").innerHTML='<span class="bad">no valid sample</span>'; return; }
  state.runtime=s.body.runtime; state.model=s.body.model||""; state.provider=s.body.provider||"";
  state.authMode=(s.body.auth&&s.body.auth.mode)||"ambient"; state.options={};
  for(const [k,v] of Object.entries(s.body)) if(!["runtime","model","auth","provider"].includes(k)) state.options[k]=v;
  renderForm();
  document.getElementById("result").innerHTML='<span class="ok">oar validateConfig PASS</span><pre>"+JSON.stringify(s.result,null,2)+"</pre>";
};
renderLedger();
state.runtime=(DATA.creatable&&DATA.creatable[0])||"";
renderForm();
</script></body></html>`;
writeFileSync("artifacts-local/create-agent-form-live.html", html);
console.log("wrote", html.length);
