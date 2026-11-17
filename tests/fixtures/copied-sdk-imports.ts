import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { copiedSdkImports } from "../../sea-trial/vendor/support/copied-sdk-imports.js";

const [entry, copy, copyEntry] = process.argv.slice(2);
assert.ok(entry !== undefined && copy !== undefined && copyEntry !== undefined);
const hooks = copiedSdkImports(entry, copy);
try {
  const loaded: unknown = await import(pathToFileURL(copyEntry).href);
  assert.ok(loaded !== null && typeof loaded === "object");
  process.stdout.write(JSON.stringify(Reflect.get(loaded, "default")));
} finally { hooks.deregister(); }
