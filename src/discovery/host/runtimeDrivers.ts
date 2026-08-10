/**
 * Host driver assembly — one import site for createHostDrivers().
 * Per-runtime change goes under ./drivers/<id>.ts (change-reason isolation).
 */
import type { RuntimeDriver } from "../../backend/trait.js";
import { claudeDriver } from "./drivers/claude.js";
import { codexDriver } from "./drivers/codex.js";
import { grokDriver } from "./drivers/grok.js";
import { antigravityDriver } from "./drivers/antigravity.js";
import { opencodeDriver } from "./drivers/opencode.js";
import { piDriver } from "./drivers/pi.js";
import { kimiDriver } from "./drivers/kimi.js";
import {
  copilotDriver,
  cursorDriver,
  geminiDriver,
} from "./drivers/misc.js";

export function createHostDrivers(): readonly RuntimeDriver[] {
  return [
    claudeDriver(),
    codexDriver(),
    grokDriver(),
    antigravityDriver(),
    copilotDriver(),
    cursorDriver(),
    geminiDriver(),
    kimiDriver(),
    opencodeDriver(),
    piDriver(),
  ];
}

export type HostDetectMeta = {
  readonly host: string;
  readonly at: string;
  readonly sources: Readonly<Record<string, string>>;
};

export function hostDetectMeta(): HostDetectMeta {
  return {
    host: process.env.RAFT_CURRENT_COMPUTER_HOSTNAME ?? process.env.HOSTNAME ?? "local",
    at: new Date().toISOString(),
    sources: {
      codex: "codex --version + ~/.codex/models_cache.json (cacheAsOf stamped on version; app-server later)",
      claude: "claude --version + claude model list help",
      grok: "grok --version + grok models",
      opencode: "opencode --version + opencode models",
      pi: "SDK in-process: package version + ModelRuntime.create({allowModelNetwork:false}).getAvailableSnapshot()",
      kimi: "SDK config pure-read: $KIMI_CODE_HOME|~/.kimi-code/config.toml [models.*] (raft detectKimiSdkModels shape)",
      antigravity: "agy --version + agy models (needs_login when sign-in required)",
      copilot: "which copilot",
      cursor: "which cursor-agent",
      gemini: "which gemini",
    },
  };
}
