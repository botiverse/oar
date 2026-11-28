/* oxlint-disable max-statements -- Each case checks one complete private-extension startup and cleanup. */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { createPiRuntime } from "../../packages/oar/src/runtimes/pi/index.js";
import { ModelConfirmationError } from "../../packages/oar/src/index.js";

const fixture = fileURLToPath(new URL("../fixtures/pi-rpc-version.ts", import.meta.url));

test.each(["1.3.99", "1.4.0", "1.5.0", "1.6.0", "unparseable", undefined])("the in-session extension independently enforces the explicit-command floor: %s", async (version) => {
  const directory = await mkdtemp(path.join(tmpdir(), "oar-pi-version-"));
  const agent = path.join(directory, "agent");
  await mkdir(agent);
  const runtime = createPiRuntime({ execution: "subprocess", command: process.execPath, args: [fixture] });
  try {
    const opening = runtime.session({ kind: "available", via: "executable", command: process.execPath }, { cwd: directory, env: {
      HOME: directory, USERPROFILE: directory, OAR_PI_AGENT_DIR: agent, PI_CODING_AGENT_DIR: agent,
      OAR_TEST_PI_READY_VERSION: version ?? null,
    } });
    if (version === "1.4.0" || version === "1.5.0" || version === "1.6.0") {
      const session = await opening;
      try { expect(session.id).toBe("version-fixture"); } finally { await session.dispose(); }
    } else {
      await expect(opening).rejects.toMatchObject({ name: "RuntimeFailureError", failure: "invalid_request",
        message: `Pi RPC requires at least 1.4.0; the selected runtime reports ${version ?? "no readable version"}. Select a supported Pi executable with createPiRuntime({ execution: "subprocess", command }).` });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.each([undefined, { provider: "fixture", id: "other" }])("a registered model with contrary RPC readback rejects with observed values: %j", async (model) => {
  const directory = await mkdtemp(path.join(tmpdir(), "oar-pi-model-"));
  const agent = path.join(directory, "agent");
  await mkdir(agent);
  const runtime = createPiRuntime({ execution: "subprocess", command: process.execPath, args: [fixture] });
  try {
    const opening = runtime.session({ kind: "available", via: "executable", command: process.execPath }, { cwd: directory, model: "fixture/requested", env: {
      HOME: directory, USERPROFILE: directory, OAR_PI_AGENT_DIR: agent, PI_CODING_AGENT_DIR: agent,
      OAR_TEST_PI_READY_VERSION: "1.5.0", OAR_TEST_PI_MODEL: model === undefined ? null : JSON.stringify(model),
    } });
    await expect(opening).rejects.toBeInstanceOf(ModelConfirmationError);
    await expect(opening).rejects.toMatchObject({ requested: "fixture/requested", reported: model === undefined ? null : "fixture/other",
      message: `pi did not apply model fixture/requested: the session reports ${model === undefined ? "no model" : "fixture/other"}` });
    await expect(opening).rejects.not.toHaveProperty("catalogSelectorIds");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
