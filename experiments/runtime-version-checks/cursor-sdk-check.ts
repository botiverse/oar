/** Compile a supplied SDK against OAR and replay its 1.4 usage shape. No SDK execution or login. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { foldCursorDelta, initialCursorProjection } from "../../packages/oar/src/runtimes/cursor/projection.js";

const [directory] = process.argv.slice(2);
assert.ok(directory !== undefined, "usage: cursor-sdk-check.ts <installed @cursor/sdk directory>");
const sdk = await readFile(path.join(directory, "package.json"), "utf8");
const manifest: unknown = JSON.parse(sdk);
assert.ok(typeof manifest === "object" && manifest !== null && "version" in manifest);
const root = fileURLToPath(new URL("../../", import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), "oar-cursor-types-"));
const sourcePath = (value: string): string => JSON.stringify(path.resolve(value).split(path.sep).join("/"));
try {
  await writeFile(path.join(temporary, "host.mts"), [
    `import * as sdk from ${sourcePath(path.join(directory, "dist/esm/index.js"))};`,
    `import type { CursorSdk } from ${sourcePath(path.join(root, "packages/oar/src/runtimes/cursor/sdk.ts"))};`,
    "const compatible: CursorSdk = sdk;",
    "void compatible;",
  ].join("\n"));
  await writeFile(path.join(temporary, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      module: "nodenext", target: "es2024", strict: true,
      exactOptionalPropertyTypes: true, noEmit: true, skipLibCheck: true,
      allowImportingTsExtensions: true, types: ["node"],
      typeRoots: [path.join(root, "node_modules/@types")],
    },
    files: ["host.mts"],
  }));
  const checked = spawnSync(process.execPath, [path.join(root, "node_modules/tsrs/bin/tsrs"), "-p", path.join(temporary, "tsconfig.json")], {
    cwd: temporary, encoding: "utf8", timeout: 30_000, windowsHide: true,
  });
  if (checked.error !== undefined) { throw checked.error; }
  assert.notEqual(checked.status, null, "compiler did not exit normally");
  const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 10 };
  const call = foldCursorDelta(initialCursorProjection, { type: "model-call-completed", modelCallId: "synthetic-call", usage });
  const turn = foldCursorDelta(call.state, { type: "turn-ended", usage });
  assert.deepEqual(call.frame.events, []);
  assert.deepEqual(turn.frame.events, [{ kind: "usage", usage: { tokens: { input: 100, output: 20, cacheRead: 30, cacheWrite: 10 } } }]);
  const diagnostics = `${checked.stdout}${checked.stderr}`
    .replaceAll(path.resolve(directory), "<sdk>")
    .replaceAll(root, "<oar>/")
    .replaceAll(temporary, "<probe>");
  console.log(JSON.stringify({ sdkVersion: manifest.version, compilerExitCode: checked.status, diagnostics, sourceDerivedUsageReplay: { callEvents: call.frame.events, turnEvents: turn.frame.events } }, null, 2));
  process.exitCode = checked.status ?? 1;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
