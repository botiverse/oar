/* oxlint-disable eslint/no-await-in-loop -- Fresh controls run serially to avoid shared machine load. */
import { runExecutable } from '../../packages/oar/src/shared/executable/run.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.env.OAR_TRIAL_RUN_DIR ?? 'oar-trial-run/antigravity-readiness', 'mcp-repeats');
mkdirSync(root, { recursive: true });
const results = [];
for (let round = 1; round <= 3; round += 1) {
  const out = path.join(root, String(round));
  mkdirSync(out, { recursive: true });
  const started = new Date().toISOString();
  const run = await runExecutable(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'sea-trial/vendor/mcp-servers-acp.vendor.test.ts', '-t', "a server named like one of the user's runs", '--maxWorkers', '1'], {
    env: { ...process.env, OAR_TRIAL_RUN_DIR: out }, timeoutMs: 190_000,
  });
  writeFileSync(path.join(out, 'output.log'), `${run.stdout}\n${run.stderr}`);
  results.push({ round, started, ended: new Date().toISOString(), ok: run.ok, exitCode: run.exitCode, diagnostics: run.diagnostics ?? null });
  writeFileSync(path.join(root, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(results.at(-1))}\n`);
}
if (results.some(row => !row.ok)) { process.exitCode = 1; }
