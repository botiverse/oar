/** Synthetic filesystem and request scheduling only; native bytes and tokens are unchanged. */
export const schedule = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const {syncBuiltinESMExports} = require('node:module');
const http = require('node:http');
const gate = process.env.OAR_TEST_TOKEN_SCHEDULE;
const prefix = path.join(gate, 'token-');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async condition => { const end=Date.now()+1500; while(!condition() && Date.now()<end) await pause(5); };
const isToken = value => path.basename(String(value))==='server.token';
const stat = fs.promises.stat;
fs.promises.stat=async function(file,...args) {
 try { return await stat.call(this,file,...args); }
 catch(error) {
  if(isToken(file) && error.code==='ENOENT') {
   fs.writeFileSync(prefix+'reader-'+process.pid,'ready');
   await wait(()=>fs.readdirSync(gate).filter(x=>x.startsWith('token-reader-')).length===2);
  }
  throw error;
 }
};
const rename=fs.promises.rename;
fs.promises.rename=async function(from,to,...args) {
 if(!isToken(to)) return rename.call(this,from,to,...args);
 let first=false;
 try { fs.writeFileSync(prefix+'first',String(process.pid),{flag:'wx'}); first=true; } catch {}
 if(!first) {await wait(()=>fs.existsSync(prefix+'banner')); await pause(40);}
 const result=await rename.call(this,from,to,...args);
 if(!first) fs.writeFileSync(prefix+'replaced','yes');
 return result;
};
const write=process.stdout.write;
process.stdout.write=function(chunk,...args) {
 const result=write.call(this,chunk,...args);
 if(String(chunk).includes('#token=')) fs.writeFileSync(prefix+'banner','yes');
 return result;
};
const emit=http.Server.prototype.emit;
http.Server.prototype.emit=function(event,...args) {
 if(event==='request' && args[0].url==='/api/v1/oauth/usage' && fs.existsSync(prefix+'first') && fs.readFileSync(prefix+'first','utf8')===String(process.pid)) {
  void wait(()=>fs.existsSync(prefix+'replaced')).then(()=>Reflect.apply(emit,this,[event,...args]));
  return true;
 }
 return Reflect.apply(emit,this,[event,...args]);
};
syncBuiltinESMExports();
`;
