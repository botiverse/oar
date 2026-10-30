import { antigravityRuntime, defineRuntime, grokRuntime, kimiRuntime, opencodeRuntime, type Runtime } from "../../packages/oar/src/index.js";
import { startAntigravityAimock, startGrokAimock, startKimiAimock, startOpencodeAimock, type AcpAimockEnv } from "./aimock-acp.js";

const backends = {
  antigravity: { runtime: antigravityRuntime, start: startAntigravityAimock },
  grok: { runtime: grokRuntime, start: startGrokAimock },
  kimi: { runtime: kimiRuntime, start: startKimiAimock },
  opencode: { runtime: opencodeRuntime, start: startOpencodeAimock },
};

/** The daily probe and CI share the same local provider and native session composition. */
export async function acpBackend(id: keyof typeof backends): Promise<{ runtime: Runtime; aimock: AcpAimockEnv }> {
  const backend = backends[id];
  const aimock = await backend.start((mock) => {
    mock.onMessage(/slow/u, { content: "ok" }, { latency: 900 });
    mock.onMessage(/^(?![\s\S]*slow)[\s\S]*$/u, { content: "ok" }, { latency: 80 });
  });
  // No account or catalog reads: those cases skip by capability, as in the daily probe.
  const { installation, session, execution } = backend.runtime;
  return { runtime: defineRuntime({ id: `${id}-aimock`, installation, session }, execution === null ? {} : { execution }), aimock };
}
