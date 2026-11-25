import { afterEach, expect, test, vi } from "vitest";
import type { SessionOptions } from "../../packages/oar/src/contracts/session.js";
import { UnsupportedOptionError } from "../../packages/oar/src/index.js";
import { codexSession } from "../../packages/oar/src/runtimes/codex/session.js";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<(command: string, args: readonly string[]) => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));

const installation = { kind: "available", via: "executable", command: "codex" } as const;
const savedSandboxEnv = process.env.OAR_CODEX_SANDBOX;

afterEach(() => {
  spawnLineProcess.mockReset();
  if (savedSandboxEnv === undefined) {
    delete process.env.OAR_CODEX_SANDBOX;
  } else {
    process.env.OAR_CODEX_SANDBOX = savedSandboxEnv;
  }
});

interface RecordedRequest {
  readonly method: string;
  readonly params: JsonRecord;
}

function replyFor(method: string): JsonRecord {
  if (method === "initialize") { return { userAgent: "codex_cli_rs/0.172.0 (Linux; x86_64)" }; }
  if (method === "config/read") { return { config: { features: { goals: true } } }; }
  if (method === "thread/fork") { return { thread: { id: "fork-thread" } }; }
  return { thread: { id: "thread-1" } };
}

function fakeAppServer(): { readonly requests: RecordedRequest[]; readonly spawnArgs: () => readonly string[] } {
  const requests: RecordedRequest[] = [];
  const fake = fakeLineProcess((text, child) => {
    const message = asRecord(JSON.parse(text));
    if (typeof message?.id !== "number" || typeof message.method !== "string") { return; }
    const request: RecordedRequest = { method: message.method, params: asRecord(message.params) ?? {} };
    requests.push(request);
    child.emit(`${JSON.stringify({ id: message.id, result: replyFor(request.method) })}\n`);
  });
  spawnLineProcess.mockReturnValue(fake);
  return {
    requests,
    spawnArgs: () => spawnLineProcess.mock.calls[0]?.[1] ?? [],
  };
}

async function openAndDispose(options: Partial<SessionOptions>): Promise<{
  readonly requests: RecordedRequest[];
  readonly args: readonly string[];
}> {
  const { requests, spawnArgs } = fakeAppServer();
  const session = await codexSession(installation, { cwd: "/work", ...options });
  const args = spawnArgs();
  await session.dispose();
  return { requests, args };
}

test("default omits nativePermissions and sends danger-full-access plus approvalPolicy never on start, resume, and fork", async () => {
  delete process.env.OAR_CODEX_SANDBOX;
  for (const [label, opts, method] of [
    ["start", {}, "thread/start"],
    ["resume", { resume: "thread-1" }, "thread/resume"],
    ["fork", { resume: "thread-1", fork: {} }, "thread/fork"],
  ] as const) {
    spawnLineProcess.mockReset();
    // oxlint-disable-next-line no-await-in-loop -- each open uses its own mocked spawn call.
    const { requests, args } = await openAndDispose(opts);
    expect(args, label).toContain('sandbox_mode="danger-full-access"');
    const open = requests.find((request) => request.method === method);
    expect(open?.params.approvalPolicy, label).toBe("never");
  }
});

test("omitted nativePermissions still honors OAR_CODEX_SANDBOX while keeping approvalPolicy never", async () => {
  process.env.OAR_CODEX_SANDBOX = "workspace-write";
  const { requests, args } = await openAndDispose({});
  expect(args).toContain('sandbox_mode="workspace-write"');
  expect(requests.find((request) => request.method === "thread/start")?.params.approvalPolicy).toBe("never");
});

test("nativePermissions inherit omits sandbox_mode and approvalPolicy on start, resume, and fork, winning over OAR_CODEX_SANDBOX", async () => {
  process.env.OAR_CODEX_SANDBOX = "danger-full-access";
  for (const [label, opts, method] of [
    ["start", { nativePermissions: "inherit" as const }, "thread/start"],
    ["resume", { resume: "thread-1", nativePermissions: "inherit" as const }, "thread/resume"],
    ["fork", { resume: "thread-1", fork: {}, nativePermissions: "inherit" as const }, "thread/fork"],
  ] as const) {
    spawnLineProcess.mockReset();
    // oxlint-disable-next-line no-await-in-loop -- each open uses its own mocked spawn call.
    const { requests, args } = await openAndDispose(opts);
    expect(args.some((arg) => arg.startsWith("sandbox_mode=")), label).toBe(false);
    const open = requests.find((request) => request.method === method);
    expect(open?.params, label).not.toHaveProperty("approvalPolicy");
  }
});

test("nativePermissions inherit preserves goals and launchArgs while omitting sandbox_mode and approvalPolicy", async () => {
  process.env.OAR_CODEX_SANDBOX = "read-only";
  const { requests, args } = await openAndDispose({
    nativePermissions: "inherit",
    goals: true,
    launchArgs: ["-c", 'shell_environment_policy.inherit="core"'],
  });
  expect(args).toEqual([
    "app-server",
    "-c",
    "features.goals=true",
    "-c",
    'shell_environment_policy.inherit="core"',
    "--listen",
    "stdio://",
  ]);
  expect(requests.find((request) => request.method === "thread/start")?.params).not.toHaveProperty("approvalPolicy");
});

test("unexpected nativePermissions value rejects before spawning app-server", async () => {
  await expect(codexSession(installation, {
    cwd: "/work",
    // @ts-expect-error -- Verify runtime validation rejects values outside the union.
    nativePermissions: "auto",
  })).rejects.toSatisfy((error: unknown) => error instanceof UnsupportedOptionError && error.option === "nativePermissions");
  expect(spawnLineProcess).not.toHaveBeenCalled();
});
