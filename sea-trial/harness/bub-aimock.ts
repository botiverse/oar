import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LLMock } from "@copilotkit/aimock";
import type { AimockEnv } from "./aimock.js";

export const BUB_AIMOCK_MODEL = "openai:aimock-model";

/** Bub's aimock environment: the env every session takes. */
export interface BubAimockEnv extends AimockEnv {
  readonly env: Readonly<Record<string, string>>;
}

/**
 * The real `bub acp` against a scripted OpenAI chat provider: a fresh
 * `BUB_HOME` (no config, tapes or session index of the user's) and Bub's
 * `openai` provider pointed at aimock with a dummy key.
 */
export async function startBubAimock(configure: (mock: LLMock) => void): Promise<BubAimockEnv> {
  const mock = new LLMock({ port: 0 });
  configure(mock);
  await mock.start();
  const home = await mkdtemp(path.join(tmpdir(), "oar-bub-aimock-"));
  return {
    env: {
      BUB_HOME: home,
      BUB_MODEL: BUB_AIMOCK_MODEL,
      BUB_OPENAI_API_KEY: "aimock",
      BUB_OPENAI_API_BASE: `${mock.url}/v1`,
    },
    mock,
    raw: [],
    stop: async () => {
      await mock.stop();
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    },
  };
}
