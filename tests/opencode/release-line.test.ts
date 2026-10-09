import { afterEach, expect, test, vi } from "vitest";
import { opencodeMajor } from "../../packages/oar/src/runtimes/opencode/version.js";
import { opencodeListModels } from "../../packages/oar/src/runtimes/opencode/list-models.js";
import { opencodeSession } from "../../packages/oar/src/runtimes/opencode/session.js";
import { runExecutable } from "../../packages/oar/src/shared/executable/run.js";

vi.mock("../../packages/oar/src/shared/executable/run.js", () => ({ runExecutable: vi.fn() }));
const run = vi.mocked(runExecutable);
const installation = { kind: "available", via: "executable", command: "opencode" } as const;
const ok = (stdout: string) => ({ ok: true, stdout, stderr: "", exitCode: null });
afterEach(() => { run.mockReset(); vi.unstubAllEnvs(); });

test.each([["1.18.35", 1], ["opencode v2.0.26", 2], ["2.0.26", 2]] as const)("native version %s selects its own release line", async (version, expected) => {
  expect(await opencodeMajor({ ...installation, version })).toBe(expected);
  expect(run).not.toHaveBeenCalled();
});

test("an explicit executable with no version is probed; unknown lines never fall back to v1", async () => {
  run.mockResolvedValueOnce(ok("opencode v2.0.26\n"));
  expect(await opencodeMajor(installation)).toBe(2);
  expect(run.mock.calls).toMatchInlineSnapshot(`
    [
      [
        "opencode",
        [
          "--version",
        ],
        {
          "timeoutMs": 15000,
        },
      ],
    ]
  `);
  await expect(opencodeMajor({ ...installation, version: "opencode v3.0.0" })).rejects.toThrow('Unrecognized opencode release line: "opencode v3.0.0"');
});

test("v1 preserves verbose model metadata and performs no new session writes", async () => {
  run.mockResolvedValueOnce(ok('opencode/big-pickle\n{\n  "name": "Big Pickle",\n  "variants": {}\n}\n'));
  expect(await opencodeListModels({ ...installation, version: "1.18.35" })).toMatchInlineSnapshot(`
    {
      "kind": "ok",
      "models": [
        {
          "displayName": "Big Pickle",
          "id": "opencode/big-pickle",
        },
      ],
    }
  `);
  expect(run.mock.calls).toMatchInlineSnapshot(`
    [
      [
        "opencode",
        [
          "models",
          "--verbose",
        ],
        {
          "timeoutMs": 30000,
        },
      ],
    ]
  `);
});

test("v2 empty native listing is unsupported, not a claim of no models", async () => {
  run.mockResolvedValueOnce(ok(""));
  expect(await opencodeListModels({ ...installation, version: "opencode v2.0.26" }, { timeoutMs: 1234 })).toMatchInlineSnapshot(`
    {
      "kind": "unsupported",
      "reason": "opencode 2.0.26 models --standalone exits before the cold catalog finishes loading; an empty response does not establish that no models exist (https://github.com/anomalyco/opencode/issues/53724)",
    }
  `);
  expect(run.mock.calls).toMatchInlineSnapshot(`
    [
      [
        "opencode",
        [
          "models",
          "--standalone",
        ],
        {
          "timeoutMs": 1234,
        },
      ],
    ]
  `);
});

test("a ready v2 standalone listing uses native IDs without inventing effort menus", async () => {
  run.mockResolvedValueOnce(ok("opencode/big-pickle\nopencode/exo-free\n"));
  expect(await opencodeListModels({ ...installation, version: "opencode v2.0.27" })).toMatchInlineSnapshot(`
    {
      "kind": "ok",
      "models": [
        {
          "id": "opencode/big-pickle",
        },
        {
          "id": "opencode/exo-free",
        },
      ],
    }
  `);
});

test("v2 failures retain native process diagnostics", async () => {
  run.mockResolvedValueOnce({ ok: false, stdout: "", stderr: "native catalog failure", exitCode: 7 });
  await expect(opencodeListModels({ ...installation, version: "opencode v2.0.26" })).rejects.toThrow("native catalog failure");
});

for (const option of ["systemPrompt", "appendSystemPrompt"] as const) {
  test.each([undefined, "old-session"])(`v2 refuses ${option} before any ACP launch or helper query, resume=%s`, async (resume) => {
    await expect(opencodeSession({ ...installation, version: "opencode v2.0.26" }, {
      cwd: "/project", [option]: "must never disappear", ...(resume === undefined ? {} : { resume }),
    })).rejects.toMatchObject({ name: "UnsupportedOptionError", option });
    expect(run).not.toHaveBeenCalled();
  });
}


test("release-line discovery uses the session cwd and environment, including removals", async () => {
  vi.stubEnv("OAR_VERSION_REMOVE", "inherited");
  vi.stubEnv("OAR_VERSION_OVERRIDE", "inherited");
  run.mockResolvedValueOnce(ok("opencode v2.0.26"));
  expect(await opencodeMajor(installation, { cwd: "/project", env: { OAR_VERSION_REMOVE: null, OAR_VERSION_OVERRIDE: "session" } })).toBe(2);
  const launched = run.mock.calls[0]?.[2];
  expect({ cwd: launched?.cwd, removed: launched?.env?.OAR_VERSION_REMOVE, overridden: launched?.env?.OAR_VERSION_OVERRIDE }).toMatchInlineSnapshot(`
    {
      "cwd": "/project",
      "overridden": "session",
      "removed": undefined,
    }
  `);
  expect(process.env.OAR_VERSION_REMOVE).toBe("inherited");
});
