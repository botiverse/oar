// Test-only observer. The installed SDK is never changed and no loader logic is replaced.
import { copiedSdkImports } from "./copied-sdk-imports.js";
import { asRecord, parseJson } from "../../../packages/oar/src/shared/json.js";
import type { createAgentPlatform } from "@cursor/sdk";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [cwd, copyPath, output] = process.argv.slice(2);
assert.ok(cwd !== undefined && copyPath !== undefined && output !== undefined);
const copy = await realpath(copyPath);
// Keep the original SDK as the source of dependency resolution.
const sdkEntry = await realpath(fileURLToPath(import.meta.resolve("@cursor/sdk")));
const sdkRoot = dirname(dirname(dirname(sdkEntry)));
const fromSdk = createRequire(sdkEntry);
const nativeRoot = dirname(fromSdk.resolve(`@cursor/sdk-${process.platform}-${process.arch}/package.json`));
process.env.CURSOR_TREE_SITTER_VENDOR_DIR = join(nativeRoot, "vendor");
process.env.CURSOR_RIPGREP_PATH = join(nativeRoot, "bin", process.platform === "win32" ? "rg.exe" : "rg");
await mkdir(copy, { recursive: true });
await cp(sdkRoot, copy, { recursive: true, filter: path => !path.endsWith("node_modules") });
const imports = copiedSdkImports(sdkEntry, copy);
process.stderr.write(`${JSON.stringify({ kind: "sdk_observer_bootstrap", sdkEntry, copy })}\n`);
const bundle = join(copy, "dist", "esm", "993.js");
const original = await readFile(bundle, "utf8");
const anchor = "const P={cursorRulesService:C,getAgentSkills:e=>E.getAllAgentSkills(e),subagentsService:x};return P";
assert.equal(original.split(anchor).length, 2, "SDK loader observation anchor changed; remeasure before updating the scanner");
const observation = ";globalThis.oarNativeSkills=()=>E.getAllAgentSkills((0,y.q6)())";
await writeFile(bundle, original.replace(anchor, anchor.replace(";return P", `${observation};return P`)));
let blockedConnections = 0;
Socket.prototype.connect = function connect(): never { blockedConnections++; throw new Error("Offline native skill probe"); };
globalThis.fetch = async (): Promise<never> => { blockedConnections++; await Promise.resolve(); throw new Error("Offline native skill probe"); };
const sdk: unknown = await import(pathToFileURL(join(copy, "dist", "esm", "index.js")).href);
assert.ok(hasPlatform(sdk));
const platform = await sdk.createAgentPlatform({ stateRoot: join(copy, "state"), workspaceRef: cwd });
let release: (() => Promise<void>) | null = null;
try {
  release = await platform.prewarmLocalWorkspace({ apiKey: "synthetic-offline", model: { id: "synthetic" }, local: { cwd, settingSources: ["project", "user"], sandboxOptions: { enabled: false } } });
  const observer: unknown = Reflect.get(globalThis, "oarNativeSkills");
  assert.ok(isObserver(observer));
  const skills = await observer();
  const packageText = await readFile(join(sdkRoot, "package.json"), "utf8");
  const packageJson = asRecord(parseJson(packageText));
  assert.ok(packageJson !== null);
  await writeFile(output, JSON.stringify({ version: packageJson.version, sourceSha256: createHash("sha256").update(original).digest("hex"), blockedConnections, skills: skills.map(skill => { const value = asRecord(skill.toJson()); assert.ok(value !== null); return { path: value.fullPath, description: value.description ?? "", disableModelInvocation: value.disableModelInvocation ?? false, invalid: value.parseError !== undefined }; }) }, null, 2));
} finally { await release?.(); imports.deregister(); }
process.exit(0);

function hasPlatform(value: unknown): value is { createAgentPlatform: typeof createAgentPlatform } { return typeof asRecord(value)?.createAgentPlatform === "function"; }
function isObserver(value: unknown): value is () => Promise<{ toJson(): unknown }[]> { return typeof value === "function"; }
