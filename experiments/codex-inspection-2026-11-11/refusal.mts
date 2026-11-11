/* oxlint-disable typescript/no-explicit-any, typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument, typescript/no-unsafe-return, typescript/explicit-function-return-type, typescript/strict-boolean-expressions, typescript/consistent-type-assertions, eslint/no-await-in-loop, eslint/max-statements, eslint/max-depth -- Inspection traces deliberately retain version-dependent native JSON and Error fields; cases run sequentially against isolated native processes. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { codexSession } from "../../packages/oar/src/runtimes/codex/session.js";
import { promptAndWait } from "../../packages/oar/src/observe/index.js";
import { startCodexAimock } from "../../sea-trial/harness/aimock.js";
import {
  prepareRun,
  publicValue,
  verifyVersion,
  verifyCleanup,
} from "./support.mjs";

const { dir, commands } = await prepareRun();
const redactions: string[] = [
  process.cwd(),
  path.resolve(import.meta.dirname, "../.."),
];
const secret = "synthetic-codex-inspection-credential";
const rows: any[] = [];
const row = async (x: any) => {
  const selected = publicValue(x, redactions);
  rows.push(selected);
  console.log(JSON.stringify(selected));
  await writeFile(
    path.join(dir, "results.json"),
    JSON.stringify(rows, null, 2),
  );
};
const serializeError = (error: any) => ({
  name: error.name,
  message: error.message,
  code: error.code,
  failure: error.failure,
  cause: error.cause,
  stack: error.stack,
  inspect: inspect(error, { depth: 10 }),
  json: JSON.stringify(error),
});
for (const { suffix, version, command } of commands) {
  const fixture = await startCodexAimock(
    (mock) => {
      mock.onMessage(
        /[\s\S]*/u,
        {
          content: "LOCAL_REFUSAL_PROBE_OK",
          usage: { input_tokens: 11, output_tokens: 7 },
        },
        { latency: 5 },
      );
    },
    { captureRaw: true, warmHome: false },
  );
  const root = await mkdtemp(path.join(tmpdir(), "oar-inspection-refusal-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  await mkdir(home);
  await mkdir(cwd);
  const wire = path.join(dir, `codex-${version}.wire.jsonl`);
  await writeFile(wire, "");
  const fault = path.join(root, "mutate-thread-id");
  const env: Record<string, string | null> = Object.fromEntries(
    Object.keys(process.env)
      .filter((k) =>
        /TOKEN|AUTH|API_KEY|SECRET|^CODEX_|^OPENAI_|^ANTHROPIC_|^CLAUDE|^NODE_OPTIONS$/iu.test(
          k,
        ),
      )
      .map((k) => [k, null]),
  );
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    HTTP_PROXY: null,
    HTTPS_PROXY: null,
    ALL_PROXY: null,
    NO_PROXY: "localhost,127.0.0.1,::1",
    OPENAI_BASE_URL: "http://127.0.0.1:9/v1",
    ...fixture.env,
    OPENAI_API_KEY: secret,
    OAR_PROBE_NATIVE_COMMAND: command,
    OAR_PROBE_WIRE_LOG: wire,
    OAR_PROBE_FAULT_FILE: fault,
  });
  const installation = {
    kind: "available",
    via: "executable",
    command: path.join(import.meta.dirname, "codex-wire.mjs"),
    version: "9.9.9",
  } as const;
  const codexHome = fixture.env?.CODEX_HOME;
  assert.ok(codexHome !== undefined);
  redactions.push(root, codexHome);
  const config = path.join(codexHome, "config.toml"),
    good = await readFile(config, "utf8");
  // Invalid TOML includes a known synthetic credential in the diagnostic source line.
  const bad = `${good}\n[${secret}\n`;
  const opts = { cwd, env, model: "gpt-5.1" };
  let current: any = null;
  const failOpen = async (name: string, extra: any, expectedCode?: string) => {
    const started = performance.now();
    let err: any = null;
    try {
      current = await codexSession(installation, { ...opts, ...extra });
      await current.dispose();
      current = undefined;
    } catch (error) {
      err = serializeError(error);
    }
    await row({
      version,
      name,
      elapsedMs: Math.round(performance.now() - started),
      error: err ?? null,
    });
    assert.ok(err, `${name} should refuse`);
    assert.ok(!JSON.stringify(err).includes(secret), "credential leak");
    if (expectedCode) {
      assert.equal(err.code, expectedCode);
      assert.equal(err.failure, "invalid_request");
    } else {
      assert.equal(err.code, undefined);
    }
    if (expectedCode === "runtime_outdated") {
      assert.ok(err.message.includes(version));
      assert.ok(!err.message.includes("9.9.9"));
    }
  };
  try {
    for (const tier of ["default", "priority"]) {
      if (suffix === "128") {
        await failOpen(
          `tier-${tier}`,
          { serviceTier: tier },
          "runtime_outdated",
        );
      } else {
        let failure: any = null;
        try {
          current = await codexSession(installation, {
            ...opts,
            serviceTier: tier,
          });
          await current.dispose();
          current = undefined;
        } catch (error) {
          failure = serializeError(error);
          assert.equal(failure.code, undefined);
          assert.match(failure.message, /reports serviceTier default/u);
        }
        assert.equal(failure === null, suffix === "132" || tier === "default");
        await row({
          version,
          name: `tier-${tier}`,
          opened: failure === null,
          error: failure,
        });
      }
    }
    if (suffix === "128") {
      await failOpen("unknown-tier", { serviceTier: "turbo" });
    } else {
      let failure: any = null;
      try {
        current = await codexSession(installation, {
          ...opts,
          serviceTier: "turbo",
        });
        await current.dispose();
        current = undefined;
      } catch (error) {
        failure = serializeError(error);
        assert.equal(failure.code, undefined);
      }
      assert.equal(failure === null, suffix === "132");
      await row({
        version,
        name: "arbitrary-tier",
        opened: failure === null,
        error: failure,
      });
    }
    await writeFile(config, bad);
    await failOpen("invalid-config-fresh", {}, "runtime_config_invalid");
    await writeFile(config, good);
    current = await codexSession(installation, opts);
    const initialized = await promptAndWait(
      current,
      "Persist local thread for refusal checks",
      { timeoutMs: 30_000 },
    );
    assert.ok(initialized.kind === "ended");
    assert.deepEqual(initialized.outcome, { kind: "completed" });
    const { id } = current;
    await row({
      version,
      name: "baseline-turn",
      outcome: initialized.outcome,
      threadId: id,
    });
    for (const mode of suffix === "167"
      ? ["oversize", "invalid-config", "missing-provider", "unknown-thread"]
      : ["oversize", "unknown-thread"]) {
      if (mode === "invalid-config") {
        await writeFile(config, bad);
      }
      if (mode === "missing-provider") {
        await writeFile(config, 'model = "gpt-5.1"\n');
      }
      if (mode === "unknown-thread") {
        await writeFile(fault, "1");
      }
      const before = current.records().length;
      const result = await current.prompt(
        mode === "oversize" ? "x".repeat(1_048_577) : `Probe ${mode}`,
      );
      const added = [...current.records()].slice(before);
      const serialized = JSON.stringify({ result, added });
      const resultSummary = {
        ...result,
        request: {
          ...result.request,
          body: {
            ...result.request.body,
            input:
              mode === "oversize"
                ? { characters: result.request.body.input.length }
                : result.request.body.input,
          },
        },
      };
      const state = current.status().value.kind;
      await row({
        version,
        name: mode,
        result: resultSummary,
        status: state,
        newRecords: added.map((r: any) => ({
          kind: r.kind,
          type: r.body.type,
        })),
        secretExposed: serialized.includes(secret),
      });
      assert.equal(result.kind, "rejected");
      assert.equal(state, "idle");
      assert.ok(!serialized.includes(secret));
      assert.equal(
        result.code,
        mode === "unknown-thread" ? "session_not_found" : "runtime_refused",
      );
      if (mode === "unknown-thread") {
        assert.equal(result.failure, undefined);
      } else {
        assert.equal(
          result.failure,
          mode === "oversize" ? "input_too_large" : "invalid_request",
        );
      }
      await writeFile(config, good);
      await rm(fault, { force: true });
    }
    const recovered = await promptAndWait(
      current,
      "Valid turn after all refusals",
      { timeoutMs: 30_000 },
    );
    assert.ok(recovered.kind === "ended");
    assert.deepEqual(recovered.outcome, { kind: "completed" });
    await row({ version, name: "recovered-turn", outcome: recovered.outcome });
    if (suffix === "128") {
      await writeFile(config, bad);
      const admission = await current.prompt(
        "One prompt after damaging old config",
      );
      await row({
        version,
        name: "old-config-next-prompt",
        kind: admission.kind,
        completionObserved: false,
      });
      assert.equal(admission.kind, "accepted");
      // Preserve the original observation boundary: admission only, then dispose.
    }
    await current.dispose();
    current = undefined;
    await writeFile(config, bad);
    await failOpen(
      "invalid-config-resume",
      { resume: id },
      "runtime_config_invalid",
    );
    await writeFile(config, good);
    if (suffix === "167") {
      current = await codexSession(installation, {
        ...opts,
        resume: id,
        effort: "high",
      });
      await row({ version, name: "resume-effort", opened: true });
      await current.dispose();
      current = undefined;
    } else {
      await failOpen(
        "resume-effort",
        { resume: id, effort: "high" },
        "runtime_outdated",
      );
    }
    await row({
      version,
      name: "provider-request-count",
      requests: fixture.raw.length,
    });
  } catch (error) {
    await row({
      version,
      name: "HARNESS_FAILURE",
      error: serializeError(error),
    });
    throw error;
  } finally {
    await current?.dispose();
    await fixture.stop();
    await rm(root, { recursive: true, force: true });
    await verifyVersion(wire, version);
    const cleanup = await verifyCleanup(wire);
    await row({ version, name: "cleanup", ...cleanup });
  }
}
