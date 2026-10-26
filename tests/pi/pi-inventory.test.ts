import { resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { piCommands, piSkills, piTools } from "../../packages/oar/src/runtimes/pi/inventory.js";

const sdk = vi.hoisted(() => ({
  getAgentDir: vi.fn(() => "/fake/agent"),
  createAgentSessionServices: vi.fn(async (_options: unknown) => ({})),
  createAgentSessionFromServices: vi.fn(),
  SessionManager: { inMemory: vi.fn((cwd: string) => ({ cwd })) },
  SettingsManager: { create: vi.fn((cwd: string) => ({ cwd, getTheme: () => "dark", getProjectSettings: () => ({}), getGlobalSettings: () => ({}) })) },
  initTheme: vi.fn(),
  defineTool: vi.fn((tool: unknown) => tool),
  createBashToolDefinition: vi.fn((cwd: string, options: { spawnHook: (context: { env: NodeJS.ProcessEnv }) => { env: NodeJS.ProcessEnv } }) => ({ name: "bash", cwd, ...options })),
}));
vi.mock("@earendil-works/pi-coding-agent", () => sdk);

const bundled = { kind: "available", via: "bundled" } as const;
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

function session() {
  return {
    resourceLoader: {
      getPrompts: (): { prompts: { name: string; description: string; argumentHint?: string; content: string; sourceInfo: { source: string } }[]; diagnostics: unknown[] } => ({ prompts: [
        { name: "review", description: "Review code", argumentHint: "<file>", content: "PRIVATE TEMPLATE", sourceInfo: { source: "local" } },
      ], diagnostics: [] }),
      getExtensions: (): { errors: unknown[] } => ({ errors: [] }),
      getSkills: () => ({
        skills: [{ name: "review", description: "Review", filePath: "/skills/review",
          disableModelInvocation: true, sourceInfo: { source: "project" } }],
        diagnostics: [{ message: "private diagnostic" }],
      }),
    },
    extensionRunner: {
      getRegisteredCommands: () => [
        { name: "review", invocationName: "review:1", description: "Extension one", handler: () => { throw new Error("must not run"); } },
        { name: "review", invocationName: "review:2" },
      ],
      getCommandDiagnostics: (): unknown[] => [],
    },
    getAllTools: () => [
      { name: "read", description: "Read", parameters: { type: "object" } },
      { name: "write", description: "Write", parameters: { type: "object" } },
    ],
    getActiveToolNames: () => ["read"],
    dispose: vi.fn(),
  };
}

test("Pi independently discovers skills, retaining invocation restrictions and diagnostic partial state", async () => {
  const agent = session();
  sdk.createAgentSessionFromServices.mockResolvedValue({ session: agent });
  const cwd = resolve("/project-b");
  const result = await piSkills(bundled, { cwd: "/project-b" });
  expect(result).toMatchObject({
    kind: "ok", partial: true, view: "discovered", scope: { kind: "workspace", cwd },
    items: [{ name: "review", description: "Review", path: "/skills/review", source: "project", disableModelInvocation: true }],
  });
  expect(sdk.createAgentSessionServices.mock.calls[0]?.[0]).toMatchObject({ cwd, agentDir: "/fake/agent", settingsManager: { cwd } });
  // pi's theme from that directory's settings, before extensions load, without the watcher.
  expect(sdk.initTheme).toHaveBeenCalledWith("dark", false);
  expect(sdk.initTheme.mock.invocationCallOrder[0]).toBeLessThan(sdk.createAgentSessionServices.mock.invocationCallOrder[0] ?? 0);
  expect(sdk.SessionManager.inMemory).toHaveBeenCalledWith(cwd);
  expect(agent.dispose).toHaveBeenCalledOnce();
});

test("Pi commands use native invocation names and expose templates without bodies or skill entries", async () => {
  const agent = session();
  sdk.createAgentSessionFromServices.mockResolvedValue({ session: agent });
  const result = await piCommands(bundled, { cwd: "project-commands" });
  expect(result).toMatchObject({ kind: "ok", view: "discovered", partial: false,
    scope: { kind: "workspace", cwd: resolve("project-commands") } });
  if (result.kind !== "ok") { throw new Error("expected native commands"); }
  expect(result.items).toMatchInlineSnapshot(`
    [
      {
        "description": "Extension one",
        "name": "review:1",
        "source": "extension",
      },
      {
        "name": "review:2",
        "source": "extension",
      },
      {
        "argumentHint": "<file>",
        "description": "Review code",
        "name": "review",
        "source": "prompt",
      },
    ]
  `);
  expect(agent.dispose).toHaveBeenCalledOnce();
});

function addDiagnostic(agent: ReturnType<typeof session>, source: string, diagnostic: unknown): void {
  if (source === "prompts") { agent.resourceLoader.getPrompts = () => ({ prompts: [], diagnostics: [diagnostic] }); }
  if (source === "extensions") { agent.resourceLoader.getExtensions = () => ({ errors: [diagnostic] }); }
  if (source === "commands") { agent.extensionRunner.getCommandDiagnostics = () => [diagnostic]; }
}

test.each(["prompts", "extensions", "commands"])("Pi %s diagnostics keep command discovery partial without exposing diagnostics", async (source) => {
  const agent = session();
  const privateError = { message: "private native diagnostic" };
  addDiagnostic(agent, source, privateError);
  sdk.createAgentSessionFromServices.mockResolvedValue({ session: agent });
  const result = await piCommands(bundled);
  expect(result).toMatchObject({ kind: "ok", partial: true });
  expect(JSON.stringify(result)).not.toContain(privateError.message);
  expect(agent.dispose).toHaveBeenCalledOnce();
});

test("Pi command read failure releases the session and hides native errors", async () => {
  const agent = session();
  agent.extensionRunner.getRegisteredCommands = () => { throw new Error("token=private"); };
  sdk.createAgentSessionFromServices.mockResolvedValue({ session: agent });
  await expect(piCommands(bundled)).resolves.toMatchObject({ kind: "unavailable", code: "query_failed", reason: "Native inventory query failed" });
  expect(agent.dispose).toHaveBeenCalledOnce();
});

test("Pi registered tools retain schema and distinguish inactive from absent", async () => {
  const agent = session();
  sdk.createAgentSessionFromServices.mockResolvedValue({ session: agent });
  const result = await piTools(bundled);
  expect(result).toMatchObject({
    kind: "ok", view: "registered", partial: false,
    items: [
      { name: "read", description: "Read", active: true, inputSchema: { type: "object" } },
      { name: "write", description: "Write", active: false, inputSchema: { type: "object" } },
    ],
  });
  expect(agent.dispose).toHaveBeenCalledOnce();
});

test("Pi query failure disposes the temporary session", async () => {
  const agent = session();
  agent.getAllTools = () => { throw new Error("private failure"); };
  sdk.createAgentSessionFromServices.mockResolvedValue({ session: agent });
  await expect(piTools(bundled)).resolves.toMatchObject({ kind: "unavailable", code: "query_failed" });
  expect(agent.dispose).toHaveBeenCalledOnce();
});

test.each([piTools, piCommands])("Pi startup resolving after the query deadline still disposes its session", async (reader) => {
  vi.useFakeTimers();
  const agent = session();
  const opening = Promise.withResolvers<{ session: ReturnType<typeof session> }>();
  sdk.createAgentSessionFromServices.mockReturnValue(opening.promise);
  const reading = reader(bundled, { timeoutMs: 20 });
  await vi.advanceTimersByTimeAsync(20);
  await expect(reading).resolves.toMatchObject({ kind: "unavailable", code: "timeout" });
  opening.resolve({ session: agent });
  await vi.advanceTimersByTimeAsync(0);
  expect(agent.dispose).toHaveBeenCalledOnce();
});


test("Pi inventory accepts env without changing SDK configuration and applies it to its bash tool", async () => {
  const agent = session();
  sdk.createAgentSessionFromServices.mockResolvedValue({ session: agent });
  const host = process.env.OAR_PI_AGENT_DIR;
  const result = await piTools(bundled, { cwd: "/inventory", env: { OAR_PI_AGENT_DIR: "child-only-dir", REMOVE: null } });
  expect(result.kind).toBe("ok");
  expect(sdk.createAgentSessionServices).toHaveBeenCalledWith(expect.objectContaining({ agentDir: host ?? "/fake/agent" }));
  const hook = sdk.createBashToolDefinition.mock.calls[0]?.[1].spawnHook;
  expect(hook?.({ env: { KEEP: "inherited", REMOVE: "remove" } }).env).toEqual({ KEEP: "inherited", OAR_PI_AGENT_DIR: "child-only-dir" });
  expect(process.env.OAR_PI_AGENT_DIR).toBe(host);
  expect(agent.dispose).toHaveBeenCalledOnce();
});
