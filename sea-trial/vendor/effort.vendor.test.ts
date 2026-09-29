import { describe, expect, test } from "vitest";
import {
  claudeInstallation,
  claudeSession,
  codexInstallation,
  codexSession,
  defineRuntime,
  piInstallation,
  piSession,
} from "../../packages/oar/src/index.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { startClaudeAimock, startCodexAimock, startPiAimock, type RawProviderRequest } from "../harness/aimock.js";
import { runtimeUnderTest } from "../harness/subject.js";
import { runTurn } from "./support/asserts.js";

/**
 * SessionOptions.effort seen from the provider's side: what each real
 * harness puts on the wire for the level oar asked for, on a new session and
 * on a resume asking for another level. The raw capture keeps the request
 * bodies aimock's journal normalizes away (raw-capture.ts).
 */

/** One reading per provider request that carries the field: a request without it is a side call (titles, summaries), not a turn. */
function readings(raw: readonly RawProviderRequest[], read: (body: Record<string, unknown>) => unknown): unknown[] {
  return raw.map((request) => read(asRecord(request.body) ?? {})).filter((value) => value !== undefined);
}

describe.skipIf(process.env.OAR_TEST !== "claude-aimock")("claude effort on the wire", () => {
  const runtime = defineRuntime({ id: "claude-aimock", session: claudeSession, installation: claudeInstallation });

  test("--effort reaches the Messages API as output_config.effort, on open and on resume", async () => {
    const env = await startClaudeAimock(undefined, { captureRaw: true });
    try {
      const subject = runtimeUnderTest(runtime, env.env);
      const session = await subject.startSession({ effort: "low" });
      await runTurn(session, "hello");
      await session.dispose();
      const resumed = await subject.startSession({ resume: session.id, effort: "high" });
      await runTurn(resumed, "and again");
      await resumed.dispose();
      expect(readings(env.raw, (body) => asRecord(body.output_config)?.effort)).toMatchInlineSnapshot(`
        [
          "low",
          "high",
        ]
      `);
      // claude's stream names no effort; its only report (get_settings) is consumed at open.
      expect([session.effort().value, resumed.effort().value]).toEqual([null, null]);
    } finally {
      await env.stop();
    }
  }, 120_000);

  test("a model that takes no effort refuses the open instead of dropping the level", async () => {
    const env = await startClaudeAimock(undefined, { captureRaw: true });
    try {
      const opened = runtimeUnderTest(runtime, env.env).startSession({ model: "haiku", effort: "low" });
      await expect(opened).rejects.toThrowErrorMatchingInlineSnapshot(`[Error: claude sends no effort for claude-haiku-4-5-20251001 (the model takes none), so effort low would be dropped]`);
      // No model call went out. Newer claude builds ping the endpoint at startup (/api/hello), which is not one.
      expect(env.raw.filter((request) => request.path.includes("/v1/messages"))).toEqual([]);
    } finally {
      await env.stop();
    }
  }, 60_000);
});

describe.skipIf(process.env.OAR_TEST !== "codex-aimock")("codex effort on the wire", () => {
  const runtime = defineRuntime({ id: "codex-aimock", session: codexSession, installation: codexInstallation });

  // The thread opens on gpt-5.5 while the aimock config.toml says gpt-5.1:
  // a resume asking only for an effort must keep the thread's model (a
  // config override on thread/resume would rebuild it from config.toml).
  test("effort reaches every turn as reasoning.effort; a resume switches it, keeps the model, and codex keeps the level", async () => {
    const env = await startCodexAimock(undefined, { captureRaw: true });
    try {
      const subject = runtimeUnderTest(runtime, env.env);
      const session = await subject.startSession({ model: "gpt-5.5", effort: "low" });
      await runTurn(session, "one");
      await runTurn(session, "two");
      await session.dispose();
      const switched = await subject.startSession({ resume: session.id, effort: "high" });
      await runTurn(switched, "three");
      await switched.dispose();
      // Asked for nothing, a resume runs (and reports) the level the thread last ran with.
      const kept = await subject.startSession({ resume: session.id });
      await runTurn(kept, "four");
      await kept.dispose();
      expect({
        wire: readings(env.raw, (body) => asRecord(body.reasoning)?.effort),
        models: readings(env.raw, (body) => (asRecord(body.reasoning) === null ? undefined : body.model)),
        reported: [session.effort().value, switched.effort().value, kept.effort().value],
        reportedModels: [session.model().value, switched.model().value, kept.model().value],
      }).toMatchInlineSnapshot(`
        {
          "models": [
            "gpt-5.5",
            "gpt-5.5",
            "gpt-5.5",
            "gpt-5.5",
          ],
          "reported": [
            "low",
            "high",
            "high",
          ],
          "reportedModels": [
            "gpt-5.5",
            "gpt-5.5",
            "gpt-5.5",
          ],
          "wire": [
            "low",
            "low",
            "high",
            "high",
          ],
        }
      `);
    } finally {
      await env.stop();
    }
  }, 180_000);
});

describe.skipIf(process.env.OAR_TEST !== "pi-aimock")("pi effort on the wire", () => {
  const runtime = defineRuntime({ id: "pi-aimock", session: piSession, installation: piInstallation });

  test("the thinking level reaches the provider on open and on resume, and pi reports it", async () => {
    const env = await startPiAimock(undefined, { captureRaw: true, reasoningModel: true });
    try {
      const subject = runtimeUnderTest(runtime, env.env);
      const session = await subject.startSession({ model: "aimock/aimock-thinking", effort: "low" });
      await runTurn(session, "hello");
      await session.dispose();
      const resumed = await subject.startSession({ resume: session.id, effort: "high" });
      await runTurn(resumed, "and again");
      await resumed.dispose();
      expect({
        wire: readings(env.raw, (body) => body.thinking),
        reported: [session.effort().value, resumed.effort().value],
      }).toMatchInlineSnapshot(`
        {
          "reported": [
            "low",
            "high",
          ],
          "wire": [
            {
              "budget_tokens": 2048,
              "display": "summarized",
              "type": "enabled",
            },
            {
              "budget_tokens": 15360,
              "display": "summarized",
              "type": "enabled",
            },
          ],
        }
      `);
    } finally {
      await env.stop();
    }
  }, 120_000);

  test("a model without thinking refuses an effort instead of clamping it to off", async () => {
    const env = await startPiAimock(undefined, { captureRaw: true, reasoningModel: true });
    try {
      const opened = runtimeUnderTest(runtime, env.env).startSession({ model: "aimock/aimock-model", effort: "low" });
      await expect(opened).rejects.toThrowErrorMatchingInlineSnapshot(`[Error: pi runs thinking level off for aimock/aimock-model although low was requested (the model offers off)]`);
      expect(env.raw).toEqual([]);
    } finally {
      await env.stop();
    }
  }, 60_000);
});
