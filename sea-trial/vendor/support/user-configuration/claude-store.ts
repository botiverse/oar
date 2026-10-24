import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runExecutable } from "../../../../packages/oar/src/shared/executable/index.js";

interface CredentialStore {
  readonly kind: "file" | "keychain";
  readonly path: string;
  write(value: unknown): Promise<void>;
  read(): Promise<unknown>;
  diagnostics(): unknown;
  close(): Promise<void>;
}

async function security(args: readonly string[], cwd: string): Promise<string> {
  const result = await runExecutable("/usr/bin/security", args, { cwd, timeoutMs: 10_000 });
  assert.ok(result.ok, `Isolated Keychain operation ${args[0] ?? "unknown"} failed (${String(result.exitCode)})`);
  return result.stdout;
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", String.raw`'\''`)}'`; }

/** Select only this disposable real Keychain, without changing the default or replacing the search list. */
async function routeSecurity(home: string, keychain: string, env: NodeJS.ProcessEnv, expected: { service: string; account: string }): Promise<void> {
  const bin = path.join(home, "security-bin"), script = path.join(bin, "route.cjs");
  await mkdir(bin);
  await writeFile(script, `const {spawnSync}=require('node:child_process');
const {readFileSync,appendFileSync}=require('node:fs');
const keychain=${JSON.stringify(keychain)};
const expected=${JSON.stringify(expected)};
const log=${JSON.stringify(path.join(home, "security-operations.jsonl"))};
const args=process.argv.slice(2);
const started=Date.now();
let input;
if(args.length===1 && args[0]==='-i') {
  const line=readFileSync(0,'utf8').trimEnd();
  if(!line.startsWith('add-generic-password ') || /[\\r\\n]/.test(line)) process.exit(2);
  input=line+' '+JSON.stringify(keychain)+'\\n';
} else if(['find-generic-password','add-generic-password','delete-generic-password','show-keychain-info'].includes(args[0])) {
  args.push(keychain);
} else process.exit(2);
const result=spawnSync('/usr/bin/security',args,{input,encoding:'utf8',stdio:['pipe','pipe','pipe']});
const value=(flag)=>args.indexOf(flag)<0?undefined:args[args.indexOf(flag)+1];
appendFileSync(log,JSON.stringify({command:args[0],elapsedMs:Date.now()-started,exitCode:result.status,
serviceMatches:value('-s')===expected.service,accountMatches:value('-a')===expected.account,
outputPresent:Boolean(result.stdout),errorCode:result.error?.code ?? null})+'\\n');
if(result.stdout) process.stdout.write(result.stdout);
if(result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
`);
  await writeFile(path.join(bin, "security"), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`, { mode: 0o700 });
  env.PATH = `${bin}${path.delimiter}${env.PATH ?? ""}`;
}

/** Seed the platform's native store; no host account is read or reused. */
export async function claudeCredentialStore(home: string, env: NodeJS.ProcessEnv): Promise<CredentialStore> {
  if (process.platform !== "darwin") {
    const file = path.join(home, ".claude", ".credentials.json");
    return { kind: "file", path: file,
      async write(value): Promise<void> { await writeFile(file, JSON.stringify(value), { mode: 0o600 }); },
      async read(): Promise<unknown> { return JSON.parse(await readFile(file, "utf8")); },
      diagnostics(): unknown { return { kind: "file" }; },
      async close(): Promise<void> {},
    };
  }
  const keychain = path.join(home, "fixture.keychain-db"), password = "oar-synthetic-keychain-not-a-secret";
  const service = `Claude Code-credentials-${createHash("sha256").update(path.join(home, ".claude").normalize("NFC")).digest("hex").slice(0, 8)}`;
  // Claude prefers USER for its Keychain account. Keep the isolated child and
  // seeded entry identical instead of relying on separate OS-account fallbacks.
  const account = "oar-fixture-user";
  env.USER = account;
  await security(["create-keychain", "-p", password, keychain], home);
  try {
    await security(["set-keychain-settings", "-lut", "3600", keychain], home);
    await security(["unlock-keychain", "-p", password, keychain], home);
    await security(["show-keychain-info", keychain], home);
    await routeSecurity(home, keychain, env, { service, account });
    return { kind: "keychain", path: keychain,
      async write(value): Promise<void> {
        await security(["add-generic-password", "-U", "-a", account, "-s", service, "-X", Buffer.from(JSON.stringify(value)).toString("hex"), keychain], home);
        const routed = await runExecutable("security", ["find-generic-password", "-a", account, "-s", service, "-w"], { cwd: home, env, timeoutMs: 10_000 });
        assert.ok(routed.ok, `Isolated Keychain child-route read failed (${String(routed.exitCode)})`);
        assert.deepEqual(JSON.parse(routed.stdout), value, "The child-route Keychain read must match the stored fixture");
      },
      async read(): Promise<unknown> { return JSON.parse(await security(["find-generic-password", "-a", account, "-s", service, "-w", keychain], home)); },
      async diagnostics(): Promise<unknown> {
        const operations = await readFile(path.join(home, "security-operations.jsonl"), "utf8").catch(() => "");
        return { kind: "keychain", operations: operations.trim().split("\n").filter(Boolean).map((line): unknown => JSON.parse(line)) };
      },
      async close(): Promise<void> { await security(["delete-keychain", keychain], home); },
    };
  } catch (error) { await security(["delete-keychain", keychain], home); throw error; }
}
