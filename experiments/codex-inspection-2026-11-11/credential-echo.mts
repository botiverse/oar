/* oxlint-disable typescript/no-explicit-any, typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument, typescript/no-unsafe-return, typescript/explicit-function-return-type, typescript/strict-boolean-expressions, typescript/consistent-type-assertions, eslint/no-await-in-loop, eslint/max-statements -- Inspection traces deliberately retain version-dependent native JSON and Error fields; cases run sequentially against isolated native processes. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
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
for (const { suffix, version, command } of commands) {
  const fixture = await startCodexAimock(
    (mock) => {
      mock.onMessage(/[\s\S]*/u, { content: "LOCAL_ECHO_PROBE_OK" });
    },
    { warmHome: false },
  );
  const root = await mkdtemp(path.join(tmpdir(), "oar-inspection-echo-"));
  await mkdir(path.join(root, "home"));
  await mkdir(path.join(root, "project"));
  const wire = path.join(dir, `credential-${version}.wire.jsonl`);
  await writeFile(wire, "");
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
    HOME: path.join(root, "home"),
    USERPROFILE: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "home/config"),
    HTTP_PROXY: null,
    HTTPS_PROXY: null,
    ALL_PROXY: null,
    NO_PROXY: "localhost,127.0.0.1,::1",
    OPENAI_BASE_URL: "http://127.0.0.1:9/v1",
    ...fixture.env,
    OPENAI_API_KEY: secret,
    OAR_PROBE_NATIVE_COMMAND: command,
    OAR_PROBE_WIRE_LOG: wire,
    OAR_PROBE_FAULT_FILE: path.join(root, "absent"),
  });
  const installation = {
    kind: "available",
    via: "executable",
    command: path.join(import.meta.dirname, "codex-wire.mjs"),
  } as const;
  const opts = { cwd: path.join(root, "project"), env, model: "gpt-5.1" };
  const codexHome = fixture.env?.CODEX_HOME;
  assert.ok(codexHome !== undefined);
  redactions.push(root, codexHome);
  const config = path.join(codexHome, "config.toml");
  const good = await readFile(config, "utf8");
  const bad = `web_search = "${secret}"\n${good}`;
  let session: any = null;
  try {
    session = await codexSession(installation, opts);
    const run = await promptAndWait(
      session,
      "Persist synthetic credential test thread",
      { timeoutMs: 30_000 },
    );
    assert.ok(run.kind === "ended");
    assert.deepEqual(run.outcome, { kind: "completed" });
    const { id } = session;
    await writeFile(config, bad);
    if (suffix === "167") {
      const result = await session.prompt(
        "Refuse config with credential in enum",
      );
      assert.equal(result.kind, "rejected");
      assert.equal(result.failure, "invalid_request");
      assert.ok(
        !JSON.stringify({ result, records: session.records() }).includes(
          secret,
        ),
      );
      rows.push({
        version,
        name: "control-credential-echo",
        result,
        secretExposed: false,
      });
    }
    await session.dispose();
    session = undefined;
    for (const mode of ["fresh", "resume"]) {
      let surfaces: any = null;
      try {
        session = await codexSession(installation, {
          ...opts,
          ...(mode === "resume" ? { resume: id } : {}),
        });
        await session.dispose();
        session = undefined;
      } catch (error: any) {
        surfaces = {
          name: error.name,
          message: error.message,
          code: error.code,
          failure: error.failure,
          cause: error.cause,
          stack: error.stack,
          inspect: inspect(error, { depth: 10 }),
          json: JSON.stringify(error),
        };
      }
      assert.ok(surfaces);
      assert.equal(surfaces.code, "runtime_config_invalid");
      assert.equal(surfaces.failure, "invalid_request");
      assert.ok(!JSON.stringify(surfaces).includes(secret));
      rows.push({
        version,
        name: `${mode}-credential-echo`,
        surfaces,
        secretExposed: false,
      });
    }
  } catch (error: any) {
    rows.push({
      version,
      name: "HARNESS_FAILURE",
      message: error.message,
      stack: error.stack,
    });
    throw error;
  } finally {
    await session?.dispose();
    await fixture.stop();
    await rm(root, { recursive: true, force: true });
    const echoedNativeErrors = await verifyVersion(wire, version, secret);
    const cleanup = await verifyCleanup(wire);
    rows.push({
      version,
      name: "native-echo-and-cleanup",
      echoedNativeErrors,
      ...cleanup,
    });
    await writeFile(
      path.join(dir, "credential-results.json"),
      JSON.stringify(publicValue(rows, redactions), null, 2),
    );
    console.log(JSON.stringify({ version, echoedNativeErrors, ...cleanup }));
    assert.equal(
      echoedNativeErrors,
      suffix === "167" ? 3 : 2,
      "actual native errors must echo credential",
    );
  }
}
