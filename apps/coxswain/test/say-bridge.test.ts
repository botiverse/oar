import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { describe, expect, test } from "vitest";
import { createSayBridge } from "../src/main/say-bridge.js";
import { SAY_ENV_NAME } from "../src/main/say-protocol.js";

async function runSay(env: Readonly<Record<string, string>>): Promise<void> {
  const windows = process.platform === "win32";
  const command = windows ? "powershell.exe" : "/bin/sh";
  const commandArguments = windows
    ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `& "$env:${SAY_ENV_NAME}" bridge-integration`]
    : ["-c", `"$${SAY_ENV_NAME}" bridge-integration`];
  const childEnv = { ...process.env, ...env };
  if (!windows) {
    childEnv.PATH = process.env.PATH;
  }
  const child = spawn(command, commandArguments, { env: childEnv });
  let standardError = "";
  child.stderr.on("data", (chunk: Buffer | string) => {
    standardError += chunk.toString();
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`say exited with code ${String(code)}: ${standardError.trim() || "no stderr"}`));
      }
    });
  });
}

describe("say bridge", () => {
  test("delivers through OAR_SAY after the shell rebuilds PATH", async () => {
    const messages: string[] = [];
    const bridge = await createSayBridge((message) => {
      messages.push(message);
    });
    try {
      const launcher = await readFile(bridge.command, "utf8");
      expect(launcher).not.toContain("ELECTRON_RUN_AS_NODE=1");
      expect(bridge.env[SAY_ENV_NAME]).toBe(bridge.command);
      expect(isAbsolute(bridge.env[SAY_ENV_NAME] ?? "")).toBe(true);
      await runSay(bridge.env);
      expect(messages).toEqual(["bridge-integration"]);
    } finally {
      await bridge.dispose();
    }
  });
});
