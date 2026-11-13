/* oxlint-disable eslint/no-console -- CLI probe script writes its JSON report to stdout. */
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(value));
}

function asArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const items: unknown[] = value;
  return items;
}

function isolatedEnv(home: string, apiKey?: string): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env };
  delete base.WINDSURF_API_KEY;
  delete base.DEVIN_API_KEY;
  delete base.DEVIN_ORG_ID;
  return {
    ...base,
    HOME: home,
    USERPROFILE: home,
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    ...(apiKey === undefined ? {} : { WINDSURF_API_KEY: apiKey }),
  };
}

function resolveDevinCommand(): string {
  const fromEnv = process.env.OAR_DEVIN_BIN;
  if (fromEnv !== undefined && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  const onPath = spawnSync("which", ["devin"], { encoding: "utf8" });
  if (onPath.status === 0 && onPath.stdout.trim().length > 0) {
    return onPath.stdout.trim();
  }
  return path.join(homedir(), ".local", "bin", process.platform === "win32" ? "devin.exe" : "devin");
}

function sanitizeOutput(text: string, home: string): string {
  return text.replaceAll(home, "<tmp-home>").trim();
}

function runSyncCommand(command: string, args: readonly string[], env: NodeJS.ProcessEnv): {
  readonly exitCode: number | null;
  readonly stdout: string;
} {
  const result = spawnSync(command, args, { env, encoding: "utf8", timeout: 15_000 });
  return {
    exitCode: result.status,
    stdout: result.stdout,
  };
}

class AcpProbeClient {
  private readonly child: ReturnType<typeof spawn>;
  private readonly pending = new Map<number, {
    readonly resolve: (value: JsonRecord) => void;
    readonly reject: (error: Error) => void;
  }>();
  private nextId = 1;
  private buffer = "";

  public constructor(command: string, cwd: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(command, ["--permission-mode", "dangerous", "--respect-workspace-trust", "false", "acp"], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout?.on("data", (chunk: Buffer | string) => {
      this.onData(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });
    this.child.on("exit", (code) => {
      for (const entry of this.pending.values()) {
        entry.reject(new Error(`ACP process exited with code ${String(code)}`));
      }
      this.pending.clear();
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    const remainder = lines.pop();
    this.buffer = remainder ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length > 0) {
        const raw: unknown = JSON.parse(trimmed);
        const parsed = asRecord(raw);
        if (parsed !== undefined && typeof parsed.id === "number") {
          const entry = this.pending.get(parsed.id);
          if (entry !== undefined) {
            this.pending.delete(parsed.id);
            entry.resolve(parsed);
          }
        }
      }
    }
  }

  public async request(method: string, params: JsonRecord, timeoutMs = 15_000): Promise<JsonRecord> {
    const id = this.nextId;
    this.nextId += 1;
    const { promise, resolve, reject } = Promise.withResolvers<JsonRecord>();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      reject(new Error(`ACP request ${method} timed out after ${String(timeoutMs)} ms`));
    }, timeoutMs);
    this.pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    const payload = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    this.child.stdin?.write(payload);
    const result = await promise;
    return result;
  }

  public async close(): Promise<void> {
    this.child.kill();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      await once(this.child, "exit");
    }
  }
}

async function main(): Promise<void> {
  const command = resolveDevinCommand();
  const tempHome = mkdtempSync(path.join(tmpdir(), "oar-devin-probe-"));
  try {
    const cleanEnv = isolatedEnv(tempHome);
    const keyEnv = isolatedEnv(tempHome, "sk-synthetic-probe");

    const versionRaw = runSyncCommand(command, ["--version"], cleanEnv);
    const version = { exitCode: versionRaw.exitCode, stdout: sanitizeOutput(versionRaw.stdout, tempHome) };
    const authCleanRaw = runSyncCommand(command, ["auth", "status"], cleanEnv);
    const authStatusClean = { exitCode: authCleanRaw.exitCode, stdout: sanitizeOutput(authCleanRaw.stdout, tempHome) };
    const authKeyRaw = runSyncCommand(command, ["auth", "status"], keyEnv);
    const authStatusSyntheticKey = { exitCode: authKeyRaw.exitCode, stdout: sanitizeOutput(authKeyRaw.stdout, tempHome) };

    const acp = new AcpProbeClient(command, tempHome, cleanEnv);
    let initializeResult: JsonRecord | undefined = undefined;
    let newSessionResult: JsonRecord | undefined = undefined;
    let setModeResult: JsonRecord | undefined = undefined;
    let setModelResult: JsonRecord | undefined = undefined;
    let loadMissingResult: JsonRecord | undefined = undefined;
    try {
      const initReply = await acp.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: true },
        clientInfo: { name: "oar-devin-probe", version: "0.0.0" },
      });
      const initRes = asRecord(initReply.result);
      const agentCaps = asRecord(initRes?.agentCapabilities);
      initializeResult = {
        protocolVersion: initRes?.protocolVersion,
        agentInfo: initRes?.agentInfo,
        loadSession: agentCaps?.loadSession,
        promptCapabilities: agentCaps?.promptCapabilities,
        mcpCapabilities: agentCaps?.mcpCapabilities,
        sessionCapabilities: agentCaps?.sessionCapabilities,
        authMethods: initRes?.authMethods,
      };

      const newReply = await acp.request("session/new", { cwd: tempHome, mcpServers: [] });
      const newRes = asRecord(newReply.result);
      const sessionId = typeof newRes?.sessionId === "string" ? newRes.sessionId : "";
      const modes = asRecord(newRes?.modes);
      const availableModes = asArray(modes?.availableModes).map((item) => asRecord(item)?.id);
      const configOptions = asArray(newRes?.configOptions).map((item) => {
        const option = asRecord(item);
        return {
          id: option?.id,
          category: option?.category,
          currentValue: option?.currentValue,
          optionCount: asArray(option?.options).length,
        };
      });
      newSessionResult = {
        hasSessionId: sessionId.length > 0,
        currentModeId: modes?.currentModeId,
        availableModes,
        configOptions,
      };

      if (sessionId.length > 0) {
        const bypassReply = await acp.request("session/set_mode", { sessionId, modeId: "bypass" });
        setModeResult = {
          hasError: bypassReply.error !== undefined,
          result: bypassReply.result,
        };
        const setModelReply = await acp.request("session/set_model", { sessionId, modelId: "swe-1-6-fast" });
        setModelResult = asRecord(setModelReply.error);
      }

      const loadReply = await acp.request("session/load", {
        sessionId: "00000000-0000-0000-0000-000000000000",
        cwd: tempHome,
        mcpServers: [],
      });
      loadMissingResult = asRecord(loadReply.error);
    } finally {
      await acp.close();
    }

    const report = {
      version,
      authStatusClean,
      authStatusSyntheticKey,
      acp: {
        initialize: initializeResult,
        loggedOutNewSession: newSessionResult,
        setBypassMode: setModeResult,
        setModelError: setModelResult,
        missingSessionLoadError: loadMissingResult,
      },
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }
}

await main();
