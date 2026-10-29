/**
 * Provider login through the packed Pi entry must not load another runtime.
 */
const PI_AUTH_PROBE = `
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
const loaded = [];
registerHooks({
  load(url, context, nextLoad) {
    const at = url.indexOf("/node_modules/@botiverse/oar/");
    if (at !== -1) loaded.push(url.slice(at + "/node_modules/@botiverse/oar/".length));
    return nextLoad(url, context);
  },
});
const { createPiProviderAuth } = await import("@botiverse/oar/runtimes/pi");
assert.equal(typeof createPiProviderAuth, "function");
assert.ok(loaded.includes("dist/runtimes/pi/auth.js"));
assert.deepEqual(loaded.filter((file) => file.startsWith("dist/runtimes/") && !file.startsWith("dist/runtimes/pi/")), [],
  "Pi provider auth loaded another runtime adapter");
`;

export default PI_AUTH_PROBE;
