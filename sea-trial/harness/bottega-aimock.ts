import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LLMock } from "@copilotkit/aimock";
import type { AimockEnv } from "./aimock.js";

export const BOTTEGA_AIMOCK_ROUTE = "aimock/aimock-model";

export interface BottegaAimock extends AimockEnv {
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly home: string;
}

function baseFixtures(mock: LLMock): void {
  mock.onMessage(/slow/u, { content: "ok" }, { latency: 900 });
  mock.onMessage(/^(?![\s\S]*slow)[\s\S]*$/u, { content: "ok" }, { latency: 80 });
}

/** Raft's command line as far as bottega's Raft app asks it at a wake: an empty inbox, and nothing else. */
const RAFT_STAND_IN = `#!/bin/sh
if [ "$1 $2" = "inbox check" ]; then printf 'Inbox: nothing unread.\\n'; exit 0; fi
echo "raft stand-in: not scripted: $*" >&2
exit 1
`;

/**
 * The real `bottega serve` with a fresh BOTTEGA_HOME whose settings hold the
 * only model route: an endpoint on a loopback URL with a synthetic key. No
 * key file, no other endpoint, and an empty CODEX_HOME so a ChatGPT login on
 * this machine is not offered either: nothing here reaches a real service.
 * A scripted answer is text with no call, which ends a bottega turn.
 *
 * A notification signed `raft` turns bottega's Raft app on, which asks the
 * `raft` command what waits: a stand-in first on PATH answers, so a machine
 * with a real Raft login is never asked.
 */
export async function startBottegaAimock(configure: (mock: LLMock) => void = baseFixtures): Promise<BottegaAimock> {
  const mock = new LLMock({ port: 0 });
  configure(mock);
  await mock.start();
  const root = await mkdtemp(path.join(tmpdir(), "oar-bottega-aimock-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  const bin = path.join(root, "bin");
  const codexHome = path.join(root, "codex");
  await Promise.all([home, cwd, bin, codexHome].map(async (directory) => { await mkdir(directory); }));
  await writeFile(path.join(bin, "raft"), RAFT_STAND_IN, { mode: 0o755 });
  await writeFile(path.join(home, "settings.json"), `${JSON.stringify({
    endpoints: [{ id: "aimock", name: "aimock", api: "openai-completions", baseUrl: `${mock.url}/v1`, models: [{ id: "aimock-model", context: 128_000, maxTokens: 4096, reasoning: true }] }],
    services: {},
    defaults: { provider: "aimock", model: "aimock-model" },
  })}\n`);
  return {
    cwd, mock, home, raw: [],
    env: { BOTTEGA_HOME: home, CODEX_HOME: codexHome, BOTTEGA_KEY_AIMOCK: "aimock-bottega-synthetic", NO_PROXY: "*", no_proxy: "*", PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
    stop: async () => { await mock.stop(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); },
  };
}
