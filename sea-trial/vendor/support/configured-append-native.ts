import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { onTestFinished } from "vitest";
import { createRegistry, defineExtension } from "@earendil-works/pi-durable";
import { dshRuntime, factoryRuntime, type SessionOptions } from "../../../packages/oar/src/index.js";
import { startDshAimock } from "../../harness/dsh-aimock.js";
import { FACTORY_AIMOCK_MODEL, startFactoryAimock } from "../../harness/factory-aimock.js";
import { startDurableFixture } from "../../harness/pi-durable.js";
import type { ConfiguredAppendFixture } from "./configured-append.js";

/** Native DSH `system-prompt` deployment persona suffix alongside OAR's `oar:system-prompt` section. */
export async function dshConfiguredFixture(): Promise<ConfiguredAppendFixture> {
  const aimock = await startDshAimock();
  onTestFinished(async () => { await aimock.stop(); });
  const patch = path.join(aimock.home, "cordis.patch.yml");
  const parsed: unknown = JSON.parse(await readFile(patch, "utf8"));
  assert.ok(Array.isArray(parsed));
  const original: readonly unknown[] = parsed;
  const install = await dshRuntime.installation();
  assert.ok(install.kind === "available");
  return {
    raw: aimock.raw,
    placement: "system",
    configure: async (value: string) => {
      await writeFile(patch, `${JSON.stringify([...original, { id: "system-prompt", config: { personaSuffix: value } }])}\n`);
    },
    open: async (options: Partial<SessionOptions>) => {
      const session = await dshRuntime.session(install, { cwd: aimock.cwd, env: { ...aimock.env }, ...options });
      return session;
    },
  };
}

/** Global `~/.factory/AGENTS.md` (user-role system reminder) alongside Factory's `droid` preset append. */
export async function factoryConfiguredFixture(): Promise<ConfiguredAppendFixture> {
  const provider = await startFactoryAimock((mock) => { mock.onMessage(/[\s\S]*/u, { content: "ok" }); });
  onTestFinished(async () => { await provider.stop(); });
  const home = provider.env.HOME;
  assert.ok(home !== undefined);
  const install = await factoryRuntime.installation();
  assert.ok(install.kind === "available");
  return {
    raw: provider.raw,
    placement: "user_context",
    configure: async (value: string) => { await writeFile(path.join(home, ".factory", "AGENTS.md"), value); },
    open: async (options: Partial<SessionOptions>) => {
      const session = await factoryRuntime.session(install, { cwd: provider.cwd, env: { ...provider.env }, model: FACTORY_AIMOCK_MODEL, ...options });
      return session;
    },
  };
}

/** Host-registered Pi Durable extension section alongside per-conversation `instructions` (`appendSystemPrompt`). */
export async function piDurableConfiguredFixture(): Promise<ConfiguredAppendFixture> {
  let configured = "";
  const registry = createRegistry();
  registry.install(defineExtension({
    name: "configured-instructions",
    sections: [{ key: "configured", render: (): string => configured }],
  }));
  const fixture = await startDurableFixture((mock) => { mock.onMessage(/[\s\S]*/u, { content: "ok" }); }, undefined, registry);
  onTestFinished(async () => { await fixture.close(); });
  return {
    raw: fixture.raw,
    placement: "system",
    configure: async (value: string) => { await Promise.resolve(); configured = value; },
    open: async (options: Partial<SessionOptions>) => {
      const session = await fixture.runtime.session({ kind: "available", via: "bundled" }, { cwd: "/virtual", model: "aimock/aimock-model", ...options });
      return session;
    },
  };
}
