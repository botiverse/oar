/**
 * The capabilities entry loads only contract modules, no runtime adapters or SDKs.
 */
const CAPABILITIES_PROBE = `
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
const capabilities = await import("@botiverse/oar/capabilities");
const marker = "/node_modules/@botiverse/oar/";
const outside = loaded.filter((url) => !url.includes(marker + "dist/capabilities.js") && !url.includes(marker + "dist/contracts/"));
assert.deepEqual(outside, [], "capabilities loaded something outside dist/capabilities.js and dist/contracts/: " + outside.join(", "));
assert.deepEqual(Object.keys(capabilities), ["installedSessionCapabilities"]);
assert.deepEqual(capabilities.installedSessionCapabilities({ refusedSessionOptions: { fork: "static" } }, { kind: "available", via: "bundled" }), { refusedSessionOptions: { fork: "static" } });
assert.deepEqual(Object.getOwnPropertyNames(globalThis).filter((name) => !before.has(name)), [], "capabilities wrote a global");
assert.equal(process.getActiveResourcesInfo().length, resources, "capabilities left something running");
`;

export default CAPABILITIES_PROBE;
