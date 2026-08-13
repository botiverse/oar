/**
 * README is the npm contract. These strings must stay honest and must match
 * the packed-consumer examples (prove:git-consumer + library teeth).
 *
 * Mutation: restore "nothing works yet" or drop the install/import snippets → RED.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(join(root, "README.md"), "utf8");

let failed = 0;
function ok(name: string) {
  console.log(`  PASS  ${name}`);
}
function bad(name: string, detail: string) {
  failed++;
  console.error(`  FAIL  ${name}: ${detail}`);
}

const FORBIDDEN = [
  { name: "nothing-works claim", re: /nothing works yet/i },
  { name: "private pre-alpha as current status", re: /\*\*private, pre-alpha/i },
  { name: "sea-trial as publish gate", re: /sea-trial passes for every runtime driver/i },
  { name: "vendor terms silently block without owner", re: /Blocks public release, not work here/ },
  { name: "CJS require example", re: /require\(\s*["']@botiverse\/oar["']\s*\)/ },
  { name: "Pi in-process as run capability", re: /Pi in-process SDK/ },
  { name: "peers are detect-time only", re: /detect-time only/i },
  { name: "present-tense Raft consumer", re: /first in-tree consumer is|The first consumer is Raft|powers Raft/i },
];

const REQUIRED = [
  { name: "ESM-only", needle: "ESM-only" },
  { name: "Node >= 20", needle: "Node >= 20" },
  { name: "npm install snippet", needle: "npm install @botiverse/oar" },
  { name: "npx oar --help", needle: "npx oar --help" },
  { name: "npx oar detect", needle: "npx oar detect" },
  { name: "npx oar usage", needle: "npx oar usage" },
  { name: "ESM import from @botiverse/oar", needle: 'from "@botiverse/oar"' },
  { name: "detectAll example", needle: "detectAll" },
  { name: "createHostDrivers example", needle: "createHostDrivers" },
  { name: "collectUsage example", needle: "collectUsage" },
  { name: "kimi = SDK", needle: "Kimi Code SDK only" },
  { name: "kimi-cli = legacy CLI", needle: "legacy Kimi CLI" },
  { name: "0.0.1 honesty: detect+usage supported", needle: "Detect + account-usage are the supported" },
  { name: "does not claim sea-trial green", needle: "sea-trial green for every" },
  { name: "vendor terms owner xxchan", needle: "Owner: **@xxchan**" },
  { name: "Codex is the full-turn runtime", needle: "full turn" },
  { name: "Pi prompt not wired", needle: "turn/prompt API not wired" },
  { name: "peers are host-provided SDK integrations", needle: "host-provided SDK integrations" },
  { name: "Pi peer used for providers/start", needle: "providers()" },
  { name: "detectAll omits not-installed", needle: "omits" },
  { name: "detectAllRegistered keeps not_installed", needle: "detectAllRegistered" },
  {
    name: "Raft is intended consumer, not landed",
    re: /intended first\s+consumer \/ integration target/,
  },
];

console.log("readme-snippets tooth");
for (const f of FORBIDDEN) {
  if (f.re.test(readme)) {
    bad(f.name, `forbidden text still in README: ${f.re}`);
  } else {
    ok(`absent: ${f.name}`);
  }
}
for (const r of REQUIRED) {
  const hit = "re" in r && r.re ? r.re.test(readme) : Boolean(r.needle && readme.includes(r.needle));
  if (!hit) {
    bad(r.name, `missing ${"re" in r && r.re ? String(r.re) : JSON.stringify(r.needle)}`);
  } else {
    ok(r.name);
  }
}

if (failed > 0) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log("\nall readme-snippet teeth green");
