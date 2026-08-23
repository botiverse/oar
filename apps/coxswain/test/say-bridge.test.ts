import { spawn } from "node:child_process";
import { describe, expect, test } from "vitest";
import { createSayBridge } from "../src/main/say-bridge.js";

async function runSay(env: Readonly<Record<string, string>>): Promise<void> {
  const windows = process.platform === "win32";
  const command = windows ? process.env.ComSpec ?? "cmd.exe" : "say";
  const commandArguments = windows
    ? ["/d", "/s", "/c", "say bridge-integration"]
    : ["bridge-integration"];
  const child = spawn(command, commandArguments, { env: { ...process.env, ...env } });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`say exited with code ${String(code)}`));
      }
    });
  });
}

describe("say bridge", () => {
  test("injects a CLI that delivers only to its loopback bridge", async () => {
    const messages: string[] = [];
    const bridge = await createSayBridge((message) => {
      messages.push(message);
    });
    try {
      await runSay(bridge.env);
      expect(messages).toEqual(["bridge-integration"]);
    } finally {
      await bridge.dispose();
    }
  });
});
