import type { Runtime } from "../../packages/oar/src/contracts/runtime.js";
import type { McpServer, Session } from "../../packages/oar/src/contracts/session.js";
import { record } from "./trace.js";

/** What a behavior case runs against: one runtime plus how to open a session on it. */
export interface RuntimeUnderTest {
  readonly id: string;
  readonly runtime: Runtime;
  /** Probe installation, then open a session in the current directory. */
  startSession(overrides?: {
    readonly resume?: string;
    readonly model?: string;
    readonly effort?: string;
    readonly systemPrompt?: string;
    readonly appendSystemPrompt?: string;
    readonly mcpServers?: readonly McpServer[];
  }): Promise<Session>;
}

export function runtimeUnderTest(
  runtime: Runtime,
  env?: Readonly<Record<string, string>>,
): RuntimeUnderTest {
  return {
    id: runtime.id,
    runtime,
    async startSession(overrides = {}) {
      if (runtime.installation === undefined) {
        throw new Error(`${runtime.id} lacks the installation capability`);
      }
      const installation = await runtime.installation();
      if (installation.kind !== "available") {
        throw new Error(`${runtime.id} is not available: ${installation.kind}`);
      }
      const model = overrides.model ?? process.env.OAR_TEST_MODEL;
      const session = await runtime.session(installation, {
        cwd: process.cwd(),
        ...(model === undefined ? {} : { model }),
        ...(overrides.effort === undefined ? {} : { effort: overrides.effort }),
        ...(env === undefined ? {} : { env }),
        ...(overrides.resume === undefined ? {} : { resume: overrides.resume }),
        ...(overrides.systemPrompt === undefined ? {} : { systemPrompt: overrides.systemPrompt }),
        ...(overrides.appendSystemPrompt === undefined ? {} : { appendSystemPrompt: overrides.appendSystemPrompt }),
        ...(overrides.mcpServers === undefined ? {} : { mcpServers: overrides.mcpServers }),
      });
      record({ kind: "session_started", sessionId: session.id, resume: overrides.resume ?? null, effort: overrides.effort ?? null });
      session.rawEvents((entry) => {
        record({ kind: "session_record", record: entry });
      });
      return session;
    },
  };
}
