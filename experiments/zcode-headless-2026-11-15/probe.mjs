/* oxlint-disable eslint/no-await-in-loop, eslint/no-continue, promise/avoid-new, unicorn/consistent-function-scoping, eslint/no-nested-ternary -- Cases share the resume fixture and run sequentially; native process and HTTP callbacks require explicit promise bridges. */
/* oxlint-disable typescript/no-unsafe-argument, typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/strict-boolean-expressions, typescript/strict-void-return, typescript/promise-function-async, typescript/prefer-nullish-coalescing, typescript/no-unnecessary-condition -- Standalone JavaScript protocol probe: preserve opaque native JSON without projecting it through OAR types. Runtime assertions below check the observed boundaries. */
// Account-free native probe. All model requests use a loopback fixture.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const cli = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3] || "artifacts/zcode6/current");
await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(tmpdir(), "oar-zcode6-"));
const home = path.join(root, "home");
const cwd = path.join(root, "project");
await mkdir(path.join(home, ".zcode", "cli"), { recursive: true });
await mkdir(cwd);
const requests = [];
let appCalls = 0,
  appPhase = "basic",
  count = 0,
  currentCase = "basic",
  trigger = null;
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  let body = null;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    body = { raw: Buffer.concat(chunks).toString() };
  }
  requests.push({ case: currentCase, at: Date.now(), url: req.url, body });
  count++;
  trigger?.();
  res.writeHead(200, { "content-type": "text/event-stream" });
  const frame = (delta, finish = null, usage = null) =>
    res.write(
      `data: ${JSON.stringify({ id: `chatcmpl-local-${count}`, object: "chat.completion.chunk", created: 1, model: "probe-model", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`,
    );
  const done = (text) => {
    frame({ role: "assistant", reasoning_content: "LOCAL_THINK" });
    frame({ content: text });
    frame({}, "stop", {
      prompt_tokens: 13,
      completion_tokens: 7,
      total_tokens: 20,
    });
    res.end("data: [DONE]\n\n");
  };
  if (currentCase === "app") {
    appCalls++;
    if (appPhase === "stop") {
      setTimeout(() => {
        if (!res.destroyed) {
          done("APP_STOP_LATE");
        }
      }, 10_000).unref();
      return;
    }
    if (appPhase === "guide" && appCalls === 1) {
      frame({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "app_tool",
            type: "function",
            function: {
              name: "Bash",
              arguments: JSON.stringify({
                command: "sleep 1; printf APP_TOOL_DONE",
                description: "Synthetic steering boundary",
                timeout: 5000,
              }),
            },
          },
        ],
      });
      frame({}, "tool_calls", {
        prompt_tokens: 13,
        completion_tokens: 7,
        total_tokens: 20,
      });
      res.end("data: [DONE]\n\n");
      return;
    }
  }
  if (currentCase === "cancel" || currentCase === "stdin") {
    setTimeout(
      () => {
        if (!res.destroyed) {
          done("HOLD_DONE");
        }
      },
      currentCase === "cancel" ? 10_000 : 1400,
    ).unref();
    return;
  }
  const tools = body.tools || [];
  const called = (body.messages || []).some((m) => m.role === "tool");
  if (
    ["tool", "plan", "question", "mcp_a", "mcp_b"].includes(currentCase) &&
    !called
  ) {
    const tool = tools.find((t) =>
      currentCase.startsWith("mcp_")
        ? t.function?.name.includes("echo")
        : t.function?.name ===
          (currentCase === "question" ? "AskUserQuestion" : "Bash"),
    );
    if (!tool) {
      done("NO_MATCHING_TOOL");
      return;
    }
    const args = currentCase.startsWith("mcp_")
      ? { text: "MCP_PROBE" }
      : currentCase === "question"
        ? {
            questions: [
              {
                question: "Choose a synthetic fixture option",
                header: "Fixture",
                options: [
                  { label: "Alpha", description: "Use alpha" },
                  { label: "Beta", description: "Use beta" },
                ],
                multiSelect: false,
              },
            ],
          }
        : {
            command:
              currentCase === "plan"
                ? "touch PLAN_PROBE"
                : "printf OAR_ZCODE_TOOL",
            description: "Run a synthetic test command",
            timeout: 5000,
          };
    frame({
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: "call_probe",
          type: "function",
          function: {
            name: tool.function.name,
            arguments: JSON.stringify(args),
          },
        },
      ],
    });
    frame({}, "tool_calls", {
      prompt_tokens: 13,
      completion_tokens: 7,
      total_tokens: 20,
    });
    res.end("data: [DONE]\n\n");
  } else {
    done(currentCase === "resume" ? "RESUME_DONE" : "LOCAL_DONE");
  }
});
await new Promise((resolve) => {
  server.listen(0, "127.0.0.1", resolve);
});
const { port } = server.address();
const provider = {
  schemaVersion: 1,
  config: {
    providerConfigRules: {
      providerRules: [
        {
          providerId: "probe",
          providerName: "Local probe",
          config: {
            group: "standard-personal",
            access: { type: "api-key", apiKey: "synthetic-local-only" },
            api: {
              type: "openai-chat-completions",
              baseUrl: `http://127.0.0.1:${port}/v1`,
            },
            personalModelIds: ["probe-model"],
          },
        },
      ],
    },
    modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    defaultModelSelection: { providerId: "probe", modelId: "probe-model" },
  },
};
const providerFile = path.join(root, "provider.json");
await writeFile(providerFile, JSON.stringify(provider));
const runtimeConfig = {
  features: { mcp: false, subagent: false, memory: false, skill: false },
  memory: { use: false },
  plugins: { enabled: false },
  skills: { enabled: false },
  hooks: { enabled: false },
  ui: { locale: "en-US" },
};
await writeFile(
  path.join(home, ".zcode", "cli", "config.json"),
  JSON.stringify(runtimeConfig),
);
const env = {
  PATH: process.env.PATH,
  HOME: home,
  USERPROFILE: home,
  TMPDIR: path.join(root, "tmp"),
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_CACHE_HOME: path.join(home, ".cache"),
  XDG_DATA_HOME: path.join(home, ".local", "share"),
  ZCODE_DATA_BASE_DIR: path.join(home, ".zcode"),
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: providerFile,
  ZCODE_STORAGE_DIR: path.join(root, "storage"),
  ZCODE_LOG_DIR: path.join(root, "logs"),
  NO_COLOR: "1",
};
await mkdir(env.TMPDIR);
const results = [];
let resume = null;
async function run(name, extra = []) {
  currentCase = name;
  count = 0;
  const start = Date.now();
  if (name.startsWith("mcp_")) {
    runtimeConfig.features.mcp = true;
    runtimeConfig.mcp = {
      servers: {
        probe: {
          type: "stdio",
          command: process.execPath,
          args: [fileURLToPath(new URL("echo.mjs", import.meta.url)), name],
          enabled: true,
        },
      },
    };
  } else {
    runtimeConfig.features.mcp = false;
    delete runtimeConfig.mcp;
  }
  await writeFile(
    path.join(home, ".zcode", "cli", "config.json"),
    JSON.stringify(runtimeConfig),
  );
  const args = [
    cli,
    "-p",
    `OAR_PROBE_${name}`,
    "--cwd",
    cwd,
    "--output-format",
    "stream-json",
    "--mode",
    name === "plan" ? "plan" : "yolo",
    ...extra,
  ];
  const child = spawn(process.execPath, args, {
    env,
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "",
    stdout = "";
  const times = [];
  child.stdout.on("data", (b) => {
    stdout += b;
    times.push({ at: Date.now() - start, bytes: b.length });
  });
  child.stderr.on("data", (b) => (stderr += b));
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  const inputActions = [];
  trigger = () => {
    if (name === "cancel") {
      setTimeout(() => {
        inputActions.push({ signal: "SIGTERM", at: Date.now() - start });
        child.kill("SIGTERM");
      }, 100);
    }
    if (name === "stdin") {
      inputActions.push({ stdin: "FOLLOW_UP_MARKER", at: Date.now() - start });
      child.stdin.write("FOLLOW_UP_MARKER\n");
    }
  };
  const exit = await new Promise((resolve) => {
    child.once("close", (code, signal) => {
      resolve({ code, signal });
    });
  });
  clearTimeout(timer);
  trigger = null;
  const frames = stdout
    .split("\n")
    .filter(Boolean)
    .map((x) => {
      try {
        return JSON.parse(x);
      } catch {
        return { unparsed: x };
      }
    });
  const result = frames.find((x) => x.type === "result");
  resume ??= result?.sessionId;
  const entry = {
    name,
    args: args.slice(1),
    durationMs: Date.now() - start,
    exit,
    frames,
    stderr,
    inputActions,
    times,
    requests: requests.filter((x) => x.case === name),
  };
  results.push(entry);
  await writeFile(
    path.join(output, `${name}.json`),
    JSON.stringify(entry, null, 2),
  );
  console.log(
    JSON.stringify({
      name,
      exit,
      types: frames.map((x) => x.type),
      result,
      stderr: stderr.slice(-500),
    }),
  );
}
async function runApp() {
  currentCase = "app";
  runtimeConfig.features.mcp = false;
  delete runtimeConfig.mcp;
  await writeFile(
    path.join(home, ".zcode", "cli", "config.json"),
    JSON.stringify(runtimeConfig),
  );
  const child = spawn(process.execPath, [cli, "app-server", "--stdio"], {
    env,
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "",
    nextId = 1,
    stderr = "";
  const frames = [];
  const sent = [];
  const pending = new Map();
  child.stderr.on("data", (b) => (stderr += b));
  child.stdout.on("data", (b) => {
    buffer += b;
    let at = -1;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      try {
        const f = JSON.parse(line);
        frames.push(f);
        if (f.id && f.method === "session/requestRuntimePreferences") {
          const answer = {
            id: f.id,
            result: {
              nativeSearchEnhancementsEnabled: false,
              toolSearchMode: "off",
              memoryEnabled: false,
              askUserQuestionAutoResolutionEnabled: false,
            },
          };
          sent.push(answer);
          child.stdin.write(`${JSON.stringify(answer)}\n`);
        }
        if (f.id && pending.has(f.id)) {
          pending.get(f.id)(f);
          pending.delete(f.id);
        }
      } catch {
        frames.push({ unparsed: line });
      }
    }
  });
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = String(nextId++),
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`RPC timeout ${method}`));
        }, 15_000);
      pending.set(id, (f) => {
        clearTimeout(timer);
        resolve(f);
      });
      const f = { id, method, params };
      sent.push(f);
      child.stdin.write(`${JSON.stringify(f)}\n`);
    });
  const waitFor = async (test) => {
    const deadline = Date.now() + 15_000;
    while (!test()) {
      if (Date.now() > deadline) {
        throw new Error("frame wait timeout");
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
    }
  };
  const outcomes = [];
  try {
    outcomes.push(await rpc("runtime/capabilities", {}));
    const workspace = { workspacePath: cwd, workspaceKey: cwd };
    const one = await rpc("session/create", {
      workspace,
      model: {
        providerId: "probe",
        modelId: "probe-model",
        options: { reasoningLevel: "enabled" },
      },
      mode: "yolo",
      titleGenerationEnabled: false,
    });
    outcomes.push(one);
    const sid = one.result?.session?.sessionId || one.result?.session?.id;
    if (!sid) {
      throw new Error("No session id in create result");
    }
    outcomes.push(
      await rpc("session/subscribe", {
        sessionId: sid,
        deliveryKind: "desktop-continuous",
        includeSnapshot: true,
      }),
      await rpc("session/send", {
        sessionId: sid,
        content: "APP_BASIC",
        modelSelection: {
          providerId: "probe",
          modelId: "probe-model",
          options: { reasoningLevel: "enabled" },
        },
      }),
    );
    await waitFor(() =>
      frames.some(
        (f) =>
          f.method === "session/event" &&
          (f.params?.type === "turn.completed" ||
            f.params?.event?.type === "turn.completed"),
      ),
    );
    outcomes.push(await rpc("session/read", { sessionId: sid }));
    const modelSelection = {
      providerId: "probe",
      modelId: "probe-model",
      options: { reasoningLevel: "enabled" },
    };
    let start = frames.length;
    appPhase = "guide";
    appCalls = 0;
    outcomes.push(
      await rpc("session/send", {
        sessionId: sid,
        content: "APP_GUIDE_BOUNDARY",
        modelSelection,
      }),
    );
    await waitFor(() =>
      frames
        .slice(start)
        .some(
          (f) =>
            f.method === "session/event" &&
            f.params?.type === "tool.updated" &&
            f.params?.payload?.kind === "started",
        ),
    );
    outcomes.push(
      await rpc("session/send", {
        sessionId: sid,
        content: "LEGACY_BUSY",
        modelSelection,
      }),
      await rpc("v4/command", {
        workspace,
        commandId: "guide-probe",
        clientId: "probe",
        sessionId: sid,
        type: "sendText",
        issuedAt: Date.now(),
        payload: {
          text: "V4_GUIDE_MARKER",
          requestedDelivery: "guide",
          modelSelection,
        },
      }),
    );
    await waitFor(() =>
      frames
        .slice(start)
        .some(
          (f) =>
            f.method === "session/event" && f.params?.type === "turn.completed",
        ),
    );
    outcomes.push(await rpc("session/read", { sessionId: sid }));
    start = frames.length;
    appPhase = "stop";
    appCalls = 0;
    outcomes.push(
      await rpc("session/send", {
        sessionId: sid,
        content: "APP_STOP_BOUNDARY",
        modelSelection,
      }),
    );
    await waitFor(() => appCalls > 0);
    outcomes.push(await rpc("session/stop", { sessionId: sid }));
    await waitFor(() =>
      frames
        .slice(start)
        .some(
          (f) =>
            f.method === "session/event" && f.params?.type === "turn.completed",
        ),
    );
    appPhase = "basic";
    appCalls = 0;
    const two = await rpc("session/create", {
      workspace,
      model: {
        providerId: "probe",
        modelId: "probe-model",
        options: { reasoningLevel: "enabled" },
      },
      mode: "plan",
      titleGenerationEnabled: false,
    });
    outcomes.push(two, await rpc("session/list", {}));
  } catch (error) {
    outcomes.push({ probeError: String(error) });
  } finally {
    child.kill("SIGTERM");
    const killer = setTimeout(() => child.kill("SIGKILL"), 8000);
    await new Promise((resolve) => {
      child.once("close", (code, signal) => {
        outcomes.push({ exit: { code, signal } });
        resolve();
      });
    });
    clearTimeout(killer);
    await writeFile(
      path.join(output, "app.json"),
      JSON.stringify(
        {
          outcomes,
          frames,
          sent,
          stderr,
          requests: requests.filter((x) => x.case === "app"),
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({
        name: "app",
        outcomes: outcomes.map(
          (x) =>
            x.error || x.probeError || x.exit || Object.keys(x.result || {}),
        ),
        stderr: stderr.slice(-500),
      }),
    );
  }
  assert.ok(!outcomes.some((x) => x.probeError), "app probe did not finish");
  assert.equal(outcomes.find((x) => x.id === "7")?.error?.code, -32_010);
  assert.equal(outcomes.find((x) => x.id === "8")?.result?.status, "accepted");
  const appEvents = frames
    .filter((f) => f.method === "session/event")
    .map((f) => f.params);
  const drained = appEvents.find((f) => f.type === "turn.steerDrained");
  assert.ok(drained, "V4 input was not drained");
  assert.ok(
    appEvents.some(
      (f) =>
        f.type === "turn.completed" &&
        f.turnId === drained.turnId &&
        f.payload.resultType === "success",
    ),
  );
  assert.ok(
    appEvents.some(
      (f) =>
        f.type === "turn.completed" && f.payload.resultType === "cancelled",
    ),
  );
  assert.ok(
    requests
      .filter((x) => x.case === "app")
      .some((x) =>
        x.body.messages.some((m) =>
          JSON.stringify(m).includes("V4_GUIDE_MARKER"),
        ),
      ),
  );
  const createdIds = [
    outcomes[1].result.session.sessionId,
    outcomes.at(-3).result.session.sessionId,
  ];
  assert.notEqual(createdIds[0], createdIds[1]);
  const listedIds = new Set(
    outcomes.at(-2).result.sessions.map((session) => session.sessionId),
  );
  assert.ok(
    createdIds.every((id) => listedIds.has(id)),
    "both app-server sessions must be listed",
  );
}
try {
  const cases = (
    process.env.PROBE_CASES ||
    "basic,tool,resume,plan,question,mcp_a,mcp_b,stdin,cancel,app"
  ).split(",");
  for (const name of cases) {
    if (name === "app") {
      await runApp();
      continue;
    }
    if (name === "resume" && !resume) {
      continue;
    }
    await run(name, name === "resume" ? ["--resume", resume] : []);
  }

  for (const entry of results) {
    const events = entry.frames;
    assert.ok(
      events.every((f) => !f.unparsed),
      `${entry.name}: non-JSON stdout`,
    );
    const completed = events.find((f) => f.type === "turn.completed");
    assert.ok(completed, `${entry.name}: missing terminal event`);
    if (entry.name === "cancel") {
      assert.equal(entry.exit.code, 143);
      assert.equal(completed.payload.resultType, "cancelled");
      assert.ok(!events.some((f) => f.type === "result"));
    } else {
      assert.equal(entry.exit.code, 0);
      assert.equal(completed.payload.resultType, "success");
      assert.ok(events.some((f) => f.type === "result"));
    }
    if (entry.name === "basic") {
      assert.ok(
        events.some(
          (f) =>
            f.type === "model.streaming" &&
            f.payload?.kind === "reasoning_delta",
        ),
      );
      assert.equal(completed.payload.usage.totalTokens, 20);
    }
    if (entry.name === "tool") {
      assert.ok(
        events.some(
          (f) =>
            f.type === "tool.updated" &&
            f.payload?.kind === "result" &&
            f.payload.result.content === "OAR_ZCODE_TOOL",
        ),
      );
    }
    if (entry.name === "resume") {
      assert.ok(
        entry.requests[0].body.messages.some(
          (m) => m.role === "assistant" && m.content === "LOCAL_DONE",
        ),
      );
    }
    if (entry.name === "stdin") {
      assert.equal(entry.requests.length, 1);
    }
    if (entry.name === "plan") {
      assert.ok(
        events.some(
          (f) =>
            f.type === "permission.resolved" && f.payload.decision === "deny",
        ),
      );
      assert.equal(
        await stat(path.join(cwd, "PLAN_PROBE")).then(
          () => true,
          () => false,
        ),
        false,
      );
    }
    if (entry.name === "question") {
      assert.ok(
        events.some(
          (f) =>
            f.type === "permission.resolved" &&
            f.payload.reason ===
              "No permission client configured for AskUserQuestion",
        ),
      );
    }
    if (entry.name.startsWith("mcp_")) {
      assert.ok(
        entry.requests.some((r) =>
          r.body.messages.some(
            (m) =>
              m.role === "tool" &&
              JSON.stringify(m.content).includes(`${entry.name}:MCP_PROBE`),
          ),
        ),
      );
    }
  }
} finally {
  server.closeAllConnections();
  server.close();
  await writeFile(
    path.join(output, "metadata.json"),
    JSON.stringify(
      { cli, node: process.version, root, cwd, home, providerFile },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(output, "requests.json"),
    JSON.stringify(requests, null, 2),
  );
}
