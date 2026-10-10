// A host bundled into one file (tests/pi/pi-static-modules.test.ts): it loads
// each of pi-ai's sign-in flows, after handing pi-ai its modules when run with
// `provide`, and prints which loaded.
import {
  loadAnthropicOAuth,
  loadGitHubCopilotOAuth,
  loadKimiCodingOAuth,
  loadMetaOAuth,
  loadOpenAIChatGPTOAuth,
  loadOpenAICodexOAuth,
  loadOpenRouterOAuth,
  loadXaiOAuth,
} from "../../node_modules/@earendil-works/pi-ai/dist/auth/oauth/load.js";
import { providePiModules } from "../../packages/oar/src/runtimes/pi/static-modules.js";

const FLOWS = [
  ["anthropic", loadAnthropicOAuth],
  ["openai-codex", loadOpenAICodexOAuth],
  ["openai-chatgpt", loadOpenAIChatGPTOAuth],
  ["github-copilot", loadGitHubCopilotOAuth],
  ["openrouter", loadOpenRouterOAuth],
  ["kimi-coding", loadKimiCodingOAuth],
  ["meta", loadMetaOAuth],
  ["xai", loadXaiOAuth],
] as const;

if (process.argv[2] === "provide") { await providePiModules(); }
const loaded = await Promise.all(FLOWS.map(async ([name, loader]) => `${name} ${await loader().then(() => "ok", () => "missing")}`));
process.stdout.write(`${loaded.join("\n")}\n`);
