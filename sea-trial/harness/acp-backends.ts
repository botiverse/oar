import { antigravityInstallation, antigravitySession, defineRuntime, grokInstallation, grokSession, kimiInstallation, kimiSession, opencodeInstallation, opencodeSession, type Runtime } from "../../packages/oar/src/index.js";
import { startAntigravityAimock, startGrokAimock, startKimiAimock, startOpencodeAimock, type AcpAimockEnv } from "./aimock-acp.js";

const backends = {
  antigravity: { installation: antigravityInstallation, session: antigravitySession, start: startAntigravityAimock },
  grok: { installation: grokInstallation, session: grokSession, start: startGrokAimock },
  kimi: { installation: kimiInstallation, session: kimiSession, start: startKimiAimock },
  opencode: { installation: opencodeInstallation, session: opencodeSession, start: startOpencodeAimock },
};

/** The daily probe and CI share the same local provider and native session composition. */
export async function acpBackend(id: keyof typeof backends): Promise<{ runtime: Runtime; aimock: AcpAimockEnv }> {
  const backend = backends[id];
  const aimock = await backend.start((mock) => {
    mock.onMessage(/slow/u, { content: "ok" }, { latency: 900 });
    mock.onMessage(/^(?![\s\S]*slow)[\s\S]*$/u, { content: "ok" }, { latency: 80 });
  });
  // No account or catalog reads: those cases skip by capability, as in the daily probe.
  return { runtime: defineRuntime({ id: `${id}-aimock`, installation: backend.installation, session: backend.session }), aimock };
}
