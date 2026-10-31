/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument, typescript/no-unsafe-return, typescript/no-misused-promises, typescript/strict-void-return, typescript/strict-boolean-expressions, typescript/no-unnecessary-condition, typescript/promise-function-async, promise/avoid-new, eslint/no-await-in-loop -- Retained standalone Linux timing observer: untyped procfs data and event-driven child lifecycle. */
import { spawn } from 'node:child_process';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { availableParallelism, loadavg } from 'node:os';
import { performance } from 'node:perf_hooks';
import path from 'node:path';

const [output, first, second] = process.argv.slice(2);
if (!output || !first || !second || process.platform !== 'linux') {throw new Error('Usage on Linux: node direct.mjs <output> <first-codebuddy> <second-codebuddy>');}
await mkdir(output, { recursive: true });
const binaries = [
  { label: 'first', command: first },
  { label: 'second', command: second },
];
async function proc(pid) {
  try {
    const raw = await readFile(`/proc/${pid}/stat`, 'utf8');
    const s = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/u);
    return { pid: Number(pid), ppid: Number(s[1]), state: s[0], start: s[19], cpuTicks: Number(s[11]) + Number(s[12]), threads: Number(s[17]), rssPages: Number(s[21]) };
  } catch { return null; }
}
async function table() {
  const names = await readdir('/proc');
  const entries = await Promise.all(names.filter(n => /^\d+$/u.test(n)).map(name => proc(name)));
  return entries.filter(Boolean);
}
async function run(binary, cohort, args = ['--help']) {
  const started = performance.now();
  const observed = new Map();
  const samples = [];
  let close = null, error = null, exit = null, timedOut = false;
  let stderrBytes = 0, stdoutBytes = 0, versionText = '';
  const child = spawn(binary.command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const at = () => Math.round((performance.now() - started) * 100) / 100;
  child.stdout?.on('data', data => { stdoutBytes += data.length; if (args[0] === '--version' && versionText.length < 4096) {versionText += data.toString();} });
  child.stderr?.on('data', data => { stderrBytes += data.length; });
  child.on('error', failure => { error = { name: failure.name, code: failure.code }; });
  child.on('exit', (code, signal) => { exit = { atMs: at(), code, signal }; });
  const finished = new Promise(resolve => { child.on('close', (code, signal) => { close = { atMs: at(), code, signal }; resolve(); }); });
  async function sample() {
    const entries = await table();
    const ids = new Set([child.pid, ...observed.keys()]);
    for (;;) {
      const before = ids.size;
      for (const entry of entries) {if (ids.has(entry.ppid)) { ids.add(entry.pid); }}
      if (before === ids.size) {break;}
    }
    const tree = entries.filter(p => ids.has(p.pid));
    for (const entry of tree) {if (!observed.has(entry.pid)) { observed.set(entry.pid, entry.start); }}
    samples.push({ atMs: at(), hostLoad: loadavg(), root: tree.find(p => p.pid === child.pid) ?? null, tree });
  }
  let sampling = Promise.resolve();
  // eslint-disable-next-line promise/prefer-await-to-then -- Serialize queued samples from the interval.
  const interval = setInterval(() => { sampling = sampling.then(sample); }, 250);
  async function terminate() {
    await sampling; await sample();
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      for (const [pid, start] of observed) {
        const current = await proc(pid);
        if (current?.start === start) { try { process.kill(pid, signal); } catch {} }
      }
      if (signal === 'SIGTERM') {await new Promise(resolve => { setTimeout(resolve, 2000); });}
    }
  }
  let termination = Promise.resolve();
  const timer = setTimeout(() => { timedOut = true; termination = terminate(); }, 15_000);
  await finished;
  clearTimeout(timer); clearInterval(interval); await sampling; await termination;
  const residual = [];
  for (const [pid, start] of observed) { const current = await proc(pid); if (current?.start === start && current.state !== 'Z') {residual.push(current);} }
  const result = { label: binary.label, cohort, args, startedAt: new Date(Date.now() - at()).toISOString(), elapsedMs: at(), pid: child.pid, timedOut, exit, close, error, stdoutBytes, stderrBytes, version: args[0] === '--version' ? /\b\d+\.\d+\.\d+\b/u.exec(versionText)?.[0] ?? null : null, samples, residual };
  await writeFile(path.join(output, `${cohort}-${binary.label}-${child.pid}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ label: result.label, cohort, elapsedMs: result.elapsedMs, timedOut, exit, close, version: result.version, cpuTicks: samples.at(-1)?.root?.cpuTicks ?? null, residual: residual.length }));
  return result;
}
const results = [];
console.log(JSON.stringify({ availableParallelism: availableParallelism(), hostLoad: loadavg(), platform: process.platform, arch: process.arch, deadlineMs: 15_000, sampleMs: 250 }));
for (let round = 0; round < 3; round++) {for (const binary of round % 2 === 0 ? binaries : binaries.toReversed()) { results.push(await run(binary, `serial-${round}`)); }}
for (const binary of binaries) {results.push(...await Promise.all(Array.from({ length: 4 }, (_, i) => run(binary, `parallel4-${i}`))));}
results.push(...await Promise.all(Array.from({ length: 8 }, (_, i) => run(binaries[i % 2], `mixed8-${i}`))));
for (const binary of binaries) {results.push(await run(binary, 'version', ['--version']));}
await writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
