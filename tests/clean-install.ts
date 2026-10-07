import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/*
 * The published packages installed the way a host installs them: packed by
 * `pnpm pack`, then `npm install`ed into an empty project. `@cursor/sdk` is
 * an optional peer dependency the host hands over
 * (`createCursorRuntime({ sdk: () => import("@cursor/sdk") })`), so a host
 * without it must still load and type-check OAR and probe every built-in
 * runtime, and the line that adds cursor must fail the host's compile. pi
 * once moved to optionalDependencies and the CLI crashed without it
 * (reverted in 026fe2c); no test inside the workspace could see that,
 * because the workspace always has every package. Then the host adds the
 * SDK: the line compiles, and cursor loads through it. The CLI, which
 * depends on the SDK, runs with cursor. Needs the npm registry; the
 * `clean-install` CI job runs it.
 */

const root = path.resolve(import.meta.dirname, "..");
const work = mkdtempSync(path.join(tmpdir(), "oar-clean-install-"));
const host = path.join(work, "host");

function run(command: string, args: readonly string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

function pack(directory: string, tarball: RegExp): string {
  run("pnpm", ["pack", "--pack-destination", work], path.join(root, directory));
  const name = readdirSync(work).find((file) => tarball.test(file)) ?? assert.fail(`no ${String(tarball)} in ${work}`);
  return path.join(work, name);
}

function npmInstall(...specs: readonly string[]): void {
  run("npm", ["install", "--no-audit", "--no-fund", ...specs], host);
}

function readJson(file: string): unknown {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  return parsed;
}

function cursorPeerVersion(): string {
  const manifest = readJson(path.join(root, "packages/oar/package.json"));
  assert.ok(typeof manifest === "object" && manifest !== null && "peerDependencies" in manifest);
  const peers = manifest.peerDependencies;
  assert.ok(typeof peers === "object" && peers !== null && "@cursor/sdk" in peers && typeof peers["@cursor/sdk"] === "string");
  return peers["@cursor/sdk"];
}

/**
 * Every entry point, then each built-in runtime's installation probe; with
 * `cursor`, also cursor added the host's way, and whether its model listing
 * reached the SDK (`unauthenticated` without a key, as in CI). Prints
 * `{ kinds, models }`.
 */
const PROBE = `
import { createCursorRuntime, defaultRuntimes } from "@botiverse/oar";
for (const entry of ["observe", "kernel", "brands", "testing", "agents"]) {
  await import("@botiverse/oar/" + entry);
}
const kinds = {};
for (const runtime of defaultRuntimes.list()) {
  kinds[runtime.id] = runtime.installation === undefined ? null : (await runtime.installation()).kind;
}
let models = null;
if (process.argv[2] === "cursor") {
  const cursor = createCursorRuntime({ sdk: () => import("@cursor/sdk") });
  const installation = await cursor.installation();
  kinds.cursor = installation.kind;
  models = (await cursor.listModels(installation)).kind;
}
console.log(JSON.stringify({ kinds, models }));
`;

// A report-only host has no reason to load a runtime. Check in its own
// process, before the other probes can populate Node's module cache.
const REPORT_PROBE = `
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
registerHooks({
  load(url, context, nextLoad) {
    assert.ok(!url.includes("/dist/runtimes/"), "report helpers loaded a runtime: " + url);
    return nextLoad(url, context);
  },
});
const { formatReport, reportOrigin } = await import("@botiverse/oar/agents/report");
const report = { id: "helper", runtime: "fake", sessionId: "session-1", turn: 1,
  outcome: { kind: "completed" }, text: "done", endedAt: 0 };
assert.equal(formatReport(report), "[subagent helper on fake, turn 1: completed; session session-1]\\ndone");
assert.deepEqual(reportOrigin(report), { kind: "notification", source: "subagent:helper" });
`;

const ENTRIES = `
import * as oar from "@botiverse/oar";
import * as agents from "@botiverse/oar/agents";
import { formatReport, reportOrigin, type SubagentReport } from "@botiverse/oar/agents/report";
import * as brands from "@botiverse/oar/brands";
import * as kernel from "@botiverse/oar/kernel";
import * as observe from "@botiverse/oar/observe";
import * as testing from "@botiverse/oar/testing";

export const entries = [oar, agents, brands, kernel, observe, testing];
export const reportInput = (report: SubagentReport) => ({ text: formatReport(report), origin: reportOrigin(report) });
`;

const ADD_CURSOR = `
import { createCursorRuntime, createRuntimeRegistry, defaultRuntimes } from "@botiverse/oar";

export const registry = createRuntimeRegistry([...defaultRuntimes.list(), createCursorRuntime({ sdk: () => import("@cursor/sdk") })]);
`;

function probe(...args: readonly string[]): { readonly kinds: Record<string, unknown>; readonly models: unknown } {
  const parsed: unknown = JSON.parse(run(process.execPath, ["probe.mjs", ...args], host));
  assert.ok(typeof parsed === "object" && parsed !== null && "kinds" in parsed && "models" in parsed);
  const { kinds, models } = parsed;
  assert.ok(typeof kinds === "object" && kinds !== null);
  return { kinds: { ...kinds }, models };
}

/** tsc over `source` as the host's `check.ts`: the errors in OAR's declarations or in that file. */
function typecheck(source: string): string[] {
  writeFileSync(path.join(host, "check.ts"), source);
  writeFileSync(path.join(host, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      module: "nodenext",
      target: "es2024",
      strict: true,
      noEmit: true,
      // A host that checks OAR's declarations must not meet an import of a
      // package it did not install.
      skipLibCheck: false,
      types: ["node"],
      typeRoots: [path.join(root, "node_modules/@types")],
    },
    files: ["check.ts"],
  }));
  const tsc = spawnSync(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json", "--pretty", "false"], {
    cwd: host,
    encoding: "utf8",
  });
  // With skipLibCheck off tsc also reports other packages' own declaration
  // errors (pi-ai imports JSON without an import attribute); only OAR's
  // declarations and the check file are this test's concern.
  return tsc.stdout.split("\n").filter((line) => line.includes(" error TS") && (line.startsWith("node_modules/@botiverse/") || !line.startsWith("node_modules/")));
}

const library = pack("packages/oar", /^botiverse-oar-\d.*\.tgz$/u);
const cli = pack("packages/cli", /^botiverse-oar-cli-.*\.tgz$/u);
mkdirSync(host);
writeFileSync(path.join(host, "package.json"), JSON.stringify({ name: "host", private: true, type: "module" }));
writeFileSync(path.join(host, "probe.mjs"), PROBE);

npmInstall(library);
run(process.execPath, ["--input-type=module", "-e", REPORT_PROBE], host);
assert.equal(readdirSync(path.join(host, "node_modules")).includes("@cursor"), false, "@cursor/sdk was installed without being asked for");
const bare = probe();
assert.equal(bare.kinds.cursor, undefined);
assert.ok(Object.values(bare.kinds).every((kind) => typeof kind === "string"), JSON.stringify(bare.kinds));
assert.deepEqual(typecheck(ENTRIES), []);
const forgotten = typecheck(ADD_CURSOR);
assert.equal(forgotten.length, 1, forgotten.join("\n"));
assert.match(forgotten[0] ?? "", /^check\.ts\(\d+,\d+\): error TS2307: Cannot find module '@cursor\/sdk'/u);

npmInstall(`@cursor/sdk@${cursorPeerVersion()}`);
assert.deepEqual(typecheck(ENTRIES), []);
assert.deepEqual(typecheck(ADD_CURSOR), []);
const withSdk = probe("cursor");
assert.equal(withSdk.kinds.cursor, "available");
assert.ok(withSdk.models === "ok" || withSdk.models === "unauthenticated", String(withSdk.models));

// The CLI brings the SDK itself: take the host's copy away first, then list
// cursor's models through the CLI's own loader (`unauthenticated` without a key).
run("npm", ["uninstall", "--no-audit", "--no-fund", "@cursor/sdk"], host);
npmInstall(cli);
const oar = path.join(host, "node_modules/.bin/oar");
assert.match(run(oar, ["--help"], host), /Usage: oar/u);
const listed: unknown = JSON.parse(run(oar, ["models", "cursor", "--json"], host));
assert.ok(Array.isArray(listed) && listed.length === 1, JSON.stringify(listed));
assert.match(JSON.stringify(listed[0]), /"runtimeId":"cursor","models":\{"kind":"(?:ok|unauthenticated)"/u);

rmSync(work, { recursive: true, force: true });
process.stdout.write(`clean install ok: built in ${JSON.stringify(bare.kinds)}; forgetting @cursor/sdk fails the host's compile\n`);
