/** Source executed directly by Node in a disposable native child. */
export const socketChildSource = String.raw`// This program is invoked by a scripted model tool call, not by the host directly.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const {url, peer, cwd} = JSON.parse(fs.readFileSync(path.join(root, 'socket-manifest.json'), 'utf8'));
const ws = new WebSocket(url);
const pending = new Map();
let serial = 0;
const rows = [];
const deadline = setTimeout(() => { fs.writeFileSync(path.join(root, 'socket-reads.json'), JSON.stringify({ timeout: true, rows })); process.exit(1); }, 20000);
ws.addEventListener('message', event => {
  const frame = JSON.parse(event.data); const settle = pending.get(frame.id);
  if (settle) { pending.delete(frame.id); settle(frame); }
});
await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, {once:true}); ws.addEventListener('error', reject, {once:true}); });
async function request(method, params) {
  const id = ++serial;
  const response = new Promise(resolve => pending.set(id, resolve));
  ws.send(JSON.stringify({id, method, params}));
  const frame = await response; rows.push({method, params, frame}); return frame;
}
try {
  await request('initialize', {clientInfo:{name:'model-shell-reader',version:'1'},capabilities:{experimentalApi:true}});
  ws.send(JSON.stringify({method:'initialized',params:{}}));
  await request('thread/list', {limit:100});
  await request('thread/read', {threadId:peer,includeTurns:false});
  await request('thread/read', {threadId:peer,includeTurns:true});
  await request('config/read', {includeLayers:true,cwd});
  fs.writeFileSync(path.join(root, 'socket-reads.json'), JSON.stringify({pid:process.pid, rows}));
  console.log('SYNTHETIC_SOCKET_READS_CAPTURED');
} finally { clearTimeout(deadline); ws.close(); }
`;
