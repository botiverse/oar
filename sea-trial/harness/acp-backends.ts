import { antigravityRuntime, defineRuntime, grokRuntime, kimiRuntime, opencodeRuntime, type AvailableInstallation, type Runtime } from "../../packages/oar/src/index.js";
import { startAntigravityAimock, startGrokAimock, startKimiAimock, startOpencodeAimock, type AcpAimockEnv } from "./aimock-acp.js";
import { observeOpenCodeStartup } from "./opencode-startup-log.js";
import { opencodePreparation } from "./opencode-home.js";

const backends = {
  antigravity: { runtime: antigravityRuntime, start: startAntigravityAimock },
  grok: { runtime: grokRuntime, start: startGrokAimock },
  kimi: { runtime: kimiRuntime, start: startKimiAimock },
  opencode: { runtime: opencodeRuntime, start: startOpencodeAimock },
};

/** The daily probe and CI share the same local provider and native session composition. */
export async function acpBackend(id: keyof typeof backends): Promise<{
  runtime: Runtime; aimock: AcpAimockEnv;
  beforeSuite?: (installation: AvailableInstallation) => Promise<void>;
}> {
  const backend = backends[id];
  const aimock = await backend.start((mock) => {
    // OpenCode v2 emits its native context update only for a measured model step.
    const reply = id === "opencode" ? { content: "ok", usage: { input_tokens: 100, output_tokens: 10 } } : { content: "ok" };
    mock.onMessage(/slow/u, reply, { latency: 900 });
    mock.onMessage(/^(?![\s\S]*slow)[\s\S]*$/u, reply, { latency: 80 });
  });
  // No account or catalog reads: those cases skip by capability, as in the daily probe.
  const { installation, session, sessionCapabilities, execution } = backend.runtime;
  const dataRoot = aimock.env.XDG_DATA_HOME;
  const open = id === "opencode" && process.platform === "win32" && dataRoot !== undefined
    ? observeOpenCodeStartup(session, dataRoot) : session;
  return {
    runtime: defineRuntime({ id: `${id}-aimock`, installation, session: open, sessionCapabilities }, execution === null ? {} : { execution }), aimock,
    ...(id === "opencode" ? { beforeSuite: opencodePreparation(aimock.env) } : {}),
  };
}
