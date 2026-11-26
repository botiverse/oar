import { readFileSync, writeFileSync } from "node:fs";

const assetUrl = new URL("../assets/suggested-versions.json", import.meta.url);
const targetUrl = new URL("../src/suggested-versions.generated.ts", import.meta.url);

const parsed = JSON.parse(readFileSync(assetUrl, "utf8"));
const rendered = [
  "// Generated from packages/oar/assets/suggested-versions.json by packages/oar/scripts/generate-suggested-versions.mjs.",
  "// Do not edit by hand; update the JSON asset and run `pnpm --filter @botiverse/oar build`.",
  `const bundledSuggestedVersionsRaw: unknown = ${JSON.stringify(parsed, null, 2)};`,
  "",
  "export default bundledSuggestedVersionsRaw;",
  "",
].join("\n");

let existing = "";
try {
  existing = readFileSync(targetUrl, "utf8");
} catch {
  existing = "";
}

if (existing !== rendered) {
  writeFileSync(targetUrl, rendered, "utf8");
}
