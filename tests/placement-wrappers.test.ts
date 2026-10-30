import { afterEach, expect, test, vi } from "vitest";
import { antigravityRuntime, codebuddyRuntime, opencodeRuntime, type Session, type StartSession } from "../packages/oar/src/index.js";
import { createMorphRuntime } from "../packages/oar/src/community/morph/index.js";
import { startMockSession } from "../sea-trial/fixtures/mock-session.js";

const { opening } = vi.hoisted(() => ({ opening: vi.fn<StartSession>() }));
vi.mock("../packages/oar/src/shared/acp/session.js", () => ({ acpSession: () => opening }));
vi.mock("../packages/oar/src/shared/executable/run.js", () => ({
  runExecutable: async () => { await Promise.resolve(); return { ok: true, stdout: "{}", stderr: "", exitCode: 0 }; },
}));
const sessions: Session[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(async (session) => session.dispose()));
  opening.mockReset();
});

test.each([
  { label: "Antigravity direct", runtime: antigravityRuntime, version: "1.4.4", prompt: {} },
  { label: "OpenCode v1 direct", runtime: opencodeRuntime, version: "1.19.5", prompt: {} },
  { label: "OpenCode v2 direct", runtime: opencodeRuntime, version: "2.2.1", prompt: {} },
  { label: "OpenCode v1 prepared prompt", runtime: opencodeRuntime, version: "1.19.5", prompt: { appendSystemPrompt: "extra" } },
  { label: "CodeBuddy prepared prompt", runtime: codebuddyRuntime, version: "2.178.1", prompt: { systemPrompt: "replacement" } },
])("$label retains explicit isolation through its wrapper into opening records", async ({ runtime, version, prompt }) => {
  opening.mockImplementation(startMockSession);
  expect(runtime.execution).toBe("process");
  const selected = runtime.execution === "process" ? runtime.withPlacement("isolated") : runtime;
  const session = await selected.session({ kind: "available", via: "executable", command: "not-started", version }, { cwd: process.cwd(), ...prompt });
  sessions.push(session);
  expect(opening.mock.calls[0]?.[2]).toEqual({ requested: "isolated", placement: "isolated" });
  expect(session.records().slice(0, 2).map((record) => record.body)).toEqual([{ kind: "open", placement: "isolated" }, { kind: "opened", placement: "isolated" }]);
  expect(session.placement).toBe("isolated");
});

test.each(["shared", "isolated"] as const)("Morph refuses explicit %s rather than invent Console placement", async (placement) => {
  const runtime = createMorphRuntime();
  expect(runtime.execution).toBeNull();
  const selected = runtime.withPlacement(placement);
  expect(selected.execution).toBeNull();
  await expect(selected.session({ kind: "available", via: "executable", command: "not-started" }, { cwd: "." })).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "placement" });
});
