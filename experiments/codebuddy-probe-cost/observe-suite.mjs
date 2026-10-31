/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument, typescript/no-unsafe-return, typescript/no-misused-promises, typescript/strict-void-return, typescript/strict-boolean-expressions, typescript/no-unnecessary-condition, typescript/promise-function-async, promise/avoid-new, eslint/no-await-in-loop, eslint/no-continue -- Retained standalone Linux timing observer: untyped procfs data and event-driven child lifecycle. */
import { spawn } from 'node:child_process';
import { readFile, readdir, writeFile, mkdir, readlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { loadavg, availableParallelism } from 'node:os';
import { performance } from 'node:perf_hooks';
import path from 'node:path';

const [cwd, binary, output] = process.argv.slice(2);
if (!cwd || !binary || !output) {throw new Error('Usage: node observe-suite.mjs <repo> <codebuddy> <output>');}
await mkdir(output, { recursive: true });
const log = createWriteStream(path.join(output, 'suite.log'));
const begun = performance.now();
const probes = new Map();
const samples = [];
const at = () => Math.round((performance.now() - begun) * 100) / 100;
async function stat(pid) {
  try {
    const raw = await readFile(`/proc/${pid}/stat`, 'utf8');
    const s = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/u);
    return { pid: Number(pid), ppid: Number(s[1]), state: s[0], start: s[19], cpuTicks: Number(s[11]) + Number(s[12]), threads: Number(s[17]), rssPages: Number(s[21]) };
  } catch { return null; }
}
const child = spawn('pnpm', ['tsx', 'sea-trial/all.ts'], { cwd, env: { ...process.env, CI: '1', OAR_TEST_REQUIRE_AVAILABLE: '1', OAR_CODEBUDDY_BIN: binary }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
let result = null;
child.on('error', error => { result = { error: error.code ?? error.name }; });
const finished = new Promise(resolve => { child.on('close', (code, signal) => { result ??= { code, signal }; resolve(); }); });
async function sample() {
  const before = at();
  const directories = await readdir('/proc');
  const names = directories.filter(n => /^\d+$/u.test(n));
  const readings = await Promise.all(names.map(name => stat(name)));
  const entries = readings.filter(Boolean);
  const treeIds = new Set([child.pid]);
  for (;;) { const count = treeIds.size; for (const entry of entries) {if (treeIds.has(entry.ppid)) { treeIds.add(entry.pid); }} if (count === treeIds.size) {break;} }
  for (const entry of entries) {
    if (!treeIds.has(entry.pid)) {continue;}
    const key = `${entry.pid}:${entry.start}`;
    if (probes.has(key)) {continue;}
    try {
      const commandLine = await readFile(`/proc/${entry.pid}/cmdline`, 'utf8');
      const args = commandLine.split('\0');
      const flag = ['--help', '--version'].find(value => args.includes(value));
      if (!flag) {continue;}
      const exe = await readlink(`/proc/${entry.pid}/exe`);
      if (path.basename(exe) !== 'codebuddy') {continue;}
      probes.set(key, { pid: entry.pid, start: entry.start, flag, firstSeenMs: at(), lastSeenMs: at(), samples: [] });
    } catch { /* A process may exit between the table and command read. */ }
  }
  const observed = [];
  for (const probe of probes.values()) {
    const entry = entries.find(item => item.pid === probe.pid && item.start === probe.start);
    if (entry) {
      const item = { atMs: at(), ...entry };
      probe.lastSeenMs = item.atMs; probe.samples.push(item); observed.push(item);
    } else {probe.firstAbsentMs ??= at();}
  }
  const counters = await readFile('/proc/stat', 'utf8');
  const cpu = counters.split('\n')[0].trim().split(/\s+/u).slice(1).map(Number);
  samples.push({ atMs: at(), sampleMs: at() - before, load: loadavg(), systemProcesses: entries.length, suiteProcesses: treeIds.size, cpu, observed });
}
let active = true;
async function observe() {
  // eslint-disable-next-line no-unmodified-loop-condition -- Command completion below ends observation.
  while (active) { await sample(); if (active) { await new Promise(resolve => { setTimeout(resolve, 250); }); } }
}
// eslint-disable-next-line unicorn/prefer-top-level-await -- Observe concurrently until command completion below.
const observer = observe();
await finished; active = false; await observer; log.end();
const summary = { platform: process.platform, arch: process.arch, availableParallelism: availableParallelism(), executableVersion: process.env.CODEBUDDY_PROBE_VERSION ?? null, sampleIntervalMs: 250, deadlineChanged: false, elapsedMs: at(), result, probes: [...probes.values()], samples };
await writeFile(path.join(output, 'observations.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ elapsedMs: summary.elapsedMs, result, probes: summary.probes.map(probe => ({ pid: probe.pid, flag: probe.flag, firstSeenMs: probe.firstSeenMs, lastSeenMs: probe.lastSeenMs, firstAbsentMs: probe.firstAbsentMs, first: probe.samples[0], last: probe.samples.at(-1) })) }));
