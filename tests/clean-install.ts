import assert from "node:assert/strict";
import { build } from "esbuild";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import CAPABILITIES_PROBE from "./fixtures/capabilities-entry-probe.js";
import PI_AUTH_PROBE from "./fixtures/pi-auth-entry-probe.js";
import { assertPiMissingSnapshot, checkPiHost, DURABLE_PROBE, DURABLE_TYPES, HOST_PROBE } from "./fixtures/pi-clean-install.js";
import { cleanInstallPolicy } from "./fixtures/clean-install-pins.js";

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
const policy = cleanInstallPolicy(root, process.argv.slice(2));
const { accepted } = policy;
const work = mkdtempSync(path.join(tmpdir(), "oar-clean-install-"));
const host = path.join(work, "host");

function run(command: string, args: readonly string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

function pack(directory: string, tarball: RegExp): string {
  // Exercise a complete prepack build, even after an earlier incremental build.
  // The cache lives inside dist so deleting the output also invalidates it.
  rmSync(path.join(root, directory, "dist"), { recursive: true, force: true });
  run("pnpm", ["pack", "--pack-destination", work], path.join(root, directory));
  const name = readdirSync(work).find((file) => tarball.test(file)) ?? assert.fail(`no ${String(tarball)} in ${work}`);
  const packed = path.join(work, name);
  const license = execFileSync("tar", ["-xOf", packed, "package/LICENSE"]);
  assert.deepEqual(license, readFileSync(path.join(root, "LICENSE")), `${directory} must ship the current root LICENSE verbatim`);
  return packed;
}

function npmInstall(directory: string, extraFlags: readonly string[], ...specs: readonly string[]): void {
  run("npm", ["install", "--no-audit", "--no-fund", ...extraFlags, ...policy.npmOptions, ...specs], directory);
  for (const name of ["oar", "oar-cli"]) {
    assert.equal(existsSync(path.join(directory, "node_modules/@botiverse", name, "dist/.tsbuildinfo")), false, `${name} publishes its build cache`);
  }
}

function readJson(file: string): unknown {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  return parsed;
}

function peerVersion(name: string): string {
  const manifest = readJson(path.join(root, "packages/oar/package.json"));
  assert.ok(typeof manifest === "object" && manifest !== null && "peerDependencies" in manifest);
  const peers = manifest.peerDependencies;
  assert.ok(typeof peers === "object" && peers !== null && name in peers);
  const version: unknown = Reflect.get(peers, name);
  assert.ok(typeof version === "string");
  return version;
}

/**
 * `@botiverse/oar/agents/report` alone, in a fresh process: a host that only
 * forwards subagent reports loads that one module of OAR and no runtime
 * (#177; `@botiverse/oar/agents` loads all of them).
 */
const REPORT_PROBE = `
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
const loaded = [];
registerHooks({
  load(url, context, nextLoad) {
    assert.ok(!url.startsWith("node:"), "Pure report/observe entry loaded " + url);
    const at = url.indexOf("/node_modules/@botiverse/oar/");
    if (at !== -1) {
      loaded.push(url.slice(at + "/node_modules/@botiverse/oar/".length));
    }
    return nextLoad(url, context);
  },
});
const { formatReport, parseReport, reportOrigin } = await import("@botiverse/oar/agents/report");
assert.deepEqual(loaded, ["dist/agents/report.js"]);
const report = { id: "scout", name: "scout", runtime: "codex", sessionId: "s-1", turn: 2, outcome: { kind: "completed" }, text: "found it", endedAt: 0 };
assert.equal(formatReport(report), "[subagent scout on codex, turn 2: completed; session s-1]\\nfound it");
assert.deepEqual(reportOrigin(report), { kind: "notification", source: "subagent:scout" });
assert.deepEqual(parseReport(formatReport(report)), { id: "scout", runtime: "codex", sessionId: "s-1", turn: 2, outcome: { kind: "completed" }, body: "found it" });
const { failureText, noticeText, noticeTone, phaseLabel, taskStatusLabel, toolGroupSummary } = await import("@botiverse/oar/observe");
assert.equal(failureText("auth", "Codex", "missing"), "Codex is not signed in.");
assert.equal(noticeText({ cause: "child_turn_ended", outcome: { kind: "aborted" } }), "Subagent turn aborted");
assert.equal(noticeTone({ cause: "retry", attempt: 1 }), "warning");
assert.equal(phaseLabel("waiting_model"), "Waiting for model");
assert.equal(taskStatusLabel("stopped"), "Stopped");
assert.equal(toolGroupSummary([], "running"), "Thinking…");
assert.ok(loaded.every((file) => !file.startsWith("dist/runtimes/")), "Pure entries loaded a runtime adapter");
`;

/** The forms entry loads only its own modules, writes no global and leaves nothing running. */
const FORMS_PROBE = `
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
const loaded = [];
registerHooks({
  load(url, context, nextLoad) {
    loaded.push(url);
    return nextLoad(url, context);
  },
});
const before = new Set(Object.getOwnPropertyNames(globalThis));
const resources = process.getActiveResourcesInfo().length;
const forms = await import("@botiverse/oar/forms");
const marker = "/node_modules/@botiverse/oar/";
const outside = loaded.filter((url) => !url.includes(marker + "dist/forms/"));
assert.deepEqual(outside, [], "forms loaded something outside dist/forms: " + outside.join(", "));
const grok = forms.configForms.grok;
assert.ok(grok && grok.fields.length > 0);
assert.equal(typeof JSON.stringify(grok), "string");
assert.deepEqual(Object.keys(forms), ["configForms"]);
assert.deepEqual(Object.getOwnPropertyNames(globalThis).filter((name) => !before.has(name)), [], "forms wrote a global");
assert.equal(process.getActiveResourcesInfo().length, resources, "forms left something running");
`;

const ENTRIES = `
import * as oar from "@botiverse/oar";
import * as browser from "@botiverse/oar/browser";
import * as capabilities from "@botiverse/oar/capabilities";
import * as forms from "@botiverse/oar/forms";
import * as agents from "@botiverse/oar/agents";
import * as report from "@botiverse/oar/agents/report";
import type { SubagentReport } from "@botiverse/oar/agents/report";
import * as brands from "@botiverse/oar/brands";
import * as kernel from "@botiverse/oar/kernel";
import * as observe from "@botiverse/oar/observe";
import * as testing from "@botiverse/oar/testing";
import { createPiProviderAuth, createPiRuntime, type PiProviderAuthOptions } from "@botiverse/oar/runtimes/pi";

export const entries = [oar, browser, capabilities, forms, agents, report, brands, kernel, observe, testing];
export const runtimeAuthorHelpers = [kernel.inputImagesRefusal, kernel.withdrawHeld, browser.withdrawHeld];
export type RuntimeAuthorQueue = kernel.HeldInput[];
export const hostEntrances = [oar.defaultRuntimes, oar.orient, oar.openVoyage, oar.createRuntimeRegistry, oar.defineRuntime, oar.promptAndWait, testing.scriptedRuntime, createPiRuntime];
export type HostContracts = [oar.Runtime, oar.RuntimeRegistry, oar.Session, oar.SessionOptions, oar.Event, oar.DeliverResult, oar.TurnOutcome, oar.VoyageRecorder, oar.Orientation, oar.OrientationDepth, oar.OrientOptions, oar.RuntimeOrientation, oar.Probe<unknown>, testing.ScriptedTurn];
export type HostSessionMembers = Pick<oar.Session, "deliver" | "steer" | "resources">;

export const compactPolicy: oar.ManualCompaction | undefined = oar.claudeRuntime.manualCompaction;
export const compact = (session: oar.Session, options: oar.CompactionOptions): Promise<oar.CompactionOutcome> | undefined => session.compact?.(options);
export const checkpoint: observe.StatusState = oar.initialStatus;
export const resumeStatus = (saved: oar.StatusState, record: oar.RawEvent): observe.StatusState => observe.reduceStatus(saved, record);
export const displayStatus = (session: oar.Session): oar.AgentStatus => session.status().value;
export const resumedOptions: oar.ResumedSessionOptions | undefined = oar.claudeRuntime.resumedSessionOptions;
export const promptTiming: oar.ResumeOptionSemantics | undefined = resumedOptions?.systemPrompt;
export const writeCapture: (marker: string) => void = oar.writeShellEnvironmentCapture;
export const capture = (command: string, args: readonly string[]) => oar.userShellEnvironment({ command, args });
export async function piLogin(paths: PiProviderAuthOptions, interaction: oar.ProviderLoginInteraction, options: oar.ProviderLoginOptions) {
  const auth = await createPiProviderAuth(paths);
  return auth.login("openai", "oauth", interaction, options);
}
export const forward = (r: SubagentReport) => ({ text: report.formatReport(r), origin: report.reportOrigin(r), parsed: report.parseReport(report.formatReport(r)) });
export const display = [observe.noticeText, observe.noticeTone, observe.phaseLabel, observe.failureText, observe.taskStatusLabel];
`;

const ADD_CURSOR = `
import { createCursorRuntime, createRuntimeRegistry, defaultRuntimes } from "@botiverse/oar";

export const registry = createRuntimeRegistry([...defaultRuntimes.list(), createCursorRuntime({ sdk: () => import("@cursor/sdk") })]);
`;

function probe(directory: string, ...args: readonly string[]): { readonly kinds: Record<string, unknown>; readonly pi: unknown; readonly piRpc: unknown; readonly models: unknown } {
  const parsed: unknown = JSON.parse(run(process.execPath, ["probe.mjs", ...args], directory));
  assert.ok(typeof parsed === "object" && parsed !== null && "kinds" in parsed && "pi" in parsed && "piRpc" in parsed && "models" in parsed);
  const { kinds, pi, piRpc, models } = parsed;
  assert.ok(typeof kinds === "object" && kinds !== null);
  return { kinds: { ...kinds }, pi, piRpc, models };
}

/** Official TypeScript checks a host consuming the tsrs-built package. Keep the
 * typescript devDependency for this compatibility check, independently of OAR's
 * build compiler. Return errors in OAR's declarations or the host's check.ts. */
function typecheck(directory: string, source: string): string[] {
  writeFileSync(path.join(directory, "check.ts"), source);
  writeFileSync(path.join(directory, "tsconfig.json"), JSON.stringify({
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
    cwd: directory,
    encoding: "utf8",
  });
  // With skipLibCheck off tsc also reports other packages' own declaration
  // errors (pi-ai imports JSON without an import attribute); only OAR's
  // declarations and the check file are this test's concern.
  return tsc.stdout.split("\n").filter((line) => line.includes(" error TS") && (line.startsWith("node_modules/@botiverse/") || !line.startsWith("node_modules/")));
}

function initProject(directory: string): void {
  mkdirSync(directory);
  writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: path.basename(directory), private: true, type: "module", ...policy.hostFields }));
  writeFileSync(path.join(directory, "probe.mjs"), HOST_PROBE);
}

const library = pack("packages/oar", /^botiverse-oar-\d.*\.tgz$/u);
const cli = pack("packages/cli", /^botiverse-oar-cli-.*\.tgz$/u);

// 1. Slim host (`npm install --omit=optional`): no Pi packages installed; every
// default runtime probes without throwing, Pi reports `dependency_missing`, and
// pi-durable still loads once its peers are added.
const slim = path.join(work, "slim");
initProject(slim);
npmInstall(slim, ["--omit=optional"], library);
assert.equal(existsSync(path.join(slim, "node_modules/@cursor")), false, "@cursor/sdk was installed in slim host");
assert.equal(existsSync(path.join(slim, "node_modules/@earendil-works")), false, "@earendil-works Pi packages were installed despite --omit=optional");
const slimProbe = probe(slim);
assert.equal(slimProbe.kinds.cursor, undefined);
assertPiMissingSnapshot(slimProbe.pi, ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"]);
assertPiMissingSnapshot(slimProbe.piRpc, ["@earendil-works/pi-coding-agent/rpc-entry"]);
assert.ok(Object.values(slimProbe.kinds).every((kind) => typeof kind === "string"), JSON.stringify(slimProbe.kinds));
assert.deepEqual(typecheck(slim, ENTRIES), []);
npmInstall(slim, ["--omit=optional"], `@earendil-works/pi-durable@${accepted["@earendil-works/pi-durable"]}`, `@earendil-works/chord@${accepted["@earendil-works/chord"]}`,
  `@earendil-works/pi-ai@${accepted["@earendil-works/pi-ai"]}`, `@earendil-works/pi-ai-durable@npm:@earendil-works/pi-ai@${accepted["@earendil-works/pi-ai"]}`);
assert.deepEqual(typecheck(slim, DURABLE_TYPES), []);
run(process.execPath, ["--input-type=module", "-e", DURABLE_PROBE], slim);
assertPiMissingSnapshot(probe(slim).pi, ["@earendil-works/pi-coding-agent"]);

// 2. Default host (`npm install`): Pi optionalDependencies install by default.
initProject(host);
npmInstall(host, [], library);
const piAiVersion = await checkPiHost(host);
policy.record(host);
const browser = await build({
  stdin: { contents: 'export * from "@botiverse/oar/browser";', resolveDir: host },
  bundle: true, platform: "browser", format: "esm", write: false, metafile: true,
});
assert.deepEqual(Object.values(browser.metafile.outputs).flatMap((output) => output.imports), []);

run(process.execPath, ["--input-type=module", "-e", REPORT_PROBE], host);
run(process.execPath, ["--input-type=module", "-e", FORMS_PROBE], host);
run(process.execPath, ["--input-type=module", "-e", CAPABILITIES_PROBE], host);
run(process.execPath, ["--input-type=module", "-e", PI_AUTH_PROBE], host);
assert.equal(existsSync(path.join(host, "node_modules/@cursor")), false, "@cursor/sdk was installed without being asked for");
assert.equal(existsSync(path.join(host, "node_modules/@earendil-works/pi-durable")), false, "pi-durable was installed without being asked for");
const bare = probe(host);
assert.equal(bare.kinds.cursor, undefined);
assert.deepEqual(bare.pi, { kind: "available", via: "bundled" });
assert.deepEqual(bare.piRpc, { kind: "available", via: "bundled" });
assert.ok(Object.values(bare.kinds).every((kind) => typeof kind === "string"), JSON.stringify(bare.kinds));
assert.deepEqual(typecheck(host, ENTRIES), []);
const forgotten = typecheck(host, ADD_CURSOR);
assert.equal(forgotten.length, 1, forgotten.join("\n"));
assert.match(forgotten[0] ?? "", /^check\.ts\(\d+,\d+\): error TS2307: Cannot find module '@cursor\/sdk'/u);

npmInstall(host, [], `@earendil-works/pi-durable@${accepted["@earendil-works/pi-durable"]}`, `@earendil-works/chord@${accepted["@earendil-works/chord"]}`,
  `@earendil-works/pi-ai@${piAiVersion}`, `@earendil-works/pi-ai-durable@npm:@earendil-works/pi-ai@${accepted["@earendil-works/pi-ai"]}`);
await checkPiHost(host);
assert.deepEqual(typecheck(host, DURABLE_TYPES), []);
run(process.execPath, ["--input-type=module", "-e", DURABLE_PROBE], host);
const durable = await build({ stdin: { contents: 'export * from "@botiverse/oar/pi-durable";', resolveDir: host }, bundle: true, platform: "browser", format: "esm", write: false, metafile: true });
assert.deepEqual(Object.values(durable.metafile.outputs).flatMap((output) => output.imports), []);

npmInstall(host, [], `@cursor/sdk@${peerVersion("@cursor/sdk")}`);
assert.deepEqual(typecheck(host, ENTRIES), []);
assert.deepEqual(typecheck(host, ADD_CURSOR), []);
const withSdk = probe(host, "cursor");
assert.equal(withSdk.kinds.cursor, "available");
assert.ok(withSdk.models === "ok" || withSdk.models === "unauthenticated", String(withSdk.models));

// 3. The CLI brings both @cursor/sdk and Pi as direct dependencies, even under --omit=optional.
npmInstall(slim, ["--omit=optional"], cli);
const oar = path.join(slim, "node_modules/.bin/oar");
assert.match(run(oar, ["--help"], slim), /Usage: oar/u);
const listed: unknown = JSON.parse(run(oar, ["models", "cursor", "--json"], slim));
assert.ok(Array.isArray(listed) && listed.length === 1, JSON.stringify(listed));
assert.match(JSON.stringify(listed[0]), /"runtimeId":"cursor","models":\{"kind":"(?:ok|unauthenticated)"/u);
const piListed: unknown = JSON.parse(run(oar, ["models", "pi", "--json"], slim));
assert.ok(Array.isArray(piListed) && piListed.length === 1, JSON.stringify(piListed));
assert.match(JSON.stringify(piListed[0]), /"runtimeId":"pi","models":\{"kind":"ok"/u);

rmSync(work, { recursive: true, force: true });
policy.passed();
process.stdout.write(`clean install ${policy.mode} ok: slim ${JSON.stringify(slimProbe.kinds)}; default ${JSON.stringify(bare.kinds)}\n`);
