import { afterEach, expect, test, vi } from "vitest";
import { piSkills, piTools } from "../../packages/oar/src/runtimes/pi/inventory.js";

const sdk = vi.hoisted(() => ({
  getAgentDir: vi.fn(() => "/fake/agent"),
  createAgentSessionServices: vi.fn(async (_options: unknown) => ({})),
  createAgentSessionFromServices: vi.fn(),
  SessionManager: { inMemory: vi.fn((cwd: string) => ({ cwd })) },
}));
vi.mock("@earendil-works/pi-coding-agent", () => sdk);

const bundled = { kind: "available", via: "bundled" } as const;
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

function session() {
  return {
    resourceLoader: {
      getSkills: () => ({
        skills: [{ name: "review", description: "Review", filePath: "/skills/review",
          disableModelInvocation: true, sourceInfo: { source: "project" } }],
        diagnostics: [{ message: "private diagnostic" }],
      }),
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
  const result = await piSkills(bundled, { cwd: "/project-b" });
  expect(result).toMatchObject({
    kind: "ok", partial: true, view: "discovered", scope: { kind: "workspace", cwd: "/project-b" },
    items: [{ name: "review", description: "Review", path: "/skills/review", source: "project", disableModelInvocation: true }],
  });
  expect(sdk.createAgentSessionServices).toHaveBeenCalledWith({ cwd: "/project-b", agentDir: "/fake/agent" });
  expect(sdk.SessionManager.inMemory).toHaveBeenCalledWith("/project-b");
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

test("Pi startup resolving after the query deadline still disposes its session", async () => {
  vi.useFakeTimers();
  const agent = session();
  const opening = Promise.withResolvers<{ session: ReturnType<typeof session> }>();
  sdk.createAgentSessionFromServices.mockReturnValue(opening.promise);
  const reading = piTools(bundled, { timeoutMs: 20 });
  await vi.advanceTimersByTimeAsync(20);
  await expect(reading).resolves.toMatchObject({ kind: "unavailable", code: "timeout" });
  opening.resolve({ session: agent });
  await vi.advanceTimersByTimeAsync(0);
  expect(agent.dispose).toHaveBeenCalledOnce();
});
