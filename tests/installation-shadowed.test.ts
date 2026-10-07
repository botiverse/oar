import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, test, type TestContext } from "vitest";
import { executableInstallation, locateOnPath, shadowedCopies } from "../packages/oar/src/shared/installation.js";

const NAME = "oar-shadow-fixture";
const ENV_VAR = "OAR_SHADOW_FIXTURE_BIN";
const windows = process.platform === "win32";
// As the PATH walk spells a Windows match: the folder, the name, then the
// PATHEXT entry, which the tests pin (the walk's own default casing).
const PATHEXT = ".COM;.EXE;.BAT;.CMD";

let root = "";

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "oar-shadowed-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A scratch folder for one case; the function makes a fresh PATH folder in it. */
function scratch(): (name: string) => string {
  const base = mkdtempSync(path.join(root, "case-"));
  return (name) => {
    const dir = path.join(base, name);
    mkdirSync(dir);
    return dir;
  };
}

/** A copy of the fixture command in `dir` that prints its version, as the PATH walk spells it. */
function copyIn(dir: string, extension = ".CMD"): string {
  const file = path.join(dir, windows ? `${NAME}${extension}` : NAME);
  writeFileSync(file, windows ? "@echo off\r\necho fixture 1.0.0\r\n" : "#!/bin/sh\necho 'fixture 1.0.0'\n");
  chmodSync(file, 0o755);
  return file;
}

function assign(entries: Iterable<readonly [string, string | undefined]>): void {
  for (const [key, value] of entries) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

async function withEnv<T>(overrides: Readonly<Record<string, string | undefined>>, body: () => T | Promise<T>): Promise<T> {
  const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
  assign(Object.entries(overrides));
  try {
    return await body();
  } finally {
    assign(previous);
  }
}

/** PATH is `dirs` ahead of the machine's own, which has no fixture copy; no override. */
function onPath(...dirs: readonly string[]): Record<string, string | undefined> {
  return {
    PATH: [...dirs, process.env.PATH ?? ""].join(path.delimiter),
    ...(windows ? { PATHEXT } : {}),
    [ENV_VAR]: undefined,
  };
}

test("the copies after the one that runs are shadowed, in PATH order, a folder listed twice once", async () => {
  const dir = scratch();
  const [a, b, c] = [dir("a"), dir("b"), dir("c")];
  const [copyA, copyB, copyC] = [copyIn(a), copyIn(b), copyIn(c)];

  assert.deepEqual(await withEnv(onPath(a, b, a, c, b), () => locateOnPath(NAME)), {
    command: copyA,
    shadowed: [copyB, copyC],
  });
  assert.deepEqual(await withEnv(onPath(c, a, c), () => locateOnPath(NAME)), {
    command: copyC,
    shadowed: [copyA],
  });
  assert.equal(await withEnv(onPath(a), () => locateOnPath("oar-shadow-missing")), null);
});

test("PATH folders that resolve to one folder hold one copy (/bin beside /usr/bin)", async () => {
  const dir = scratch();
  const [real, other, first] = [dir("real"), dir("other"), dir("first")];
  const link = path.join(path.dirname(real), "link");
  symlinkSync(real, link, "junction");
  const [copyReal, copyOther, copyFirst] = [copyIn(real), copyIn(other), copyIn(first)];
  const copyLink = path.join(link, path.basename(copyReal));

  assert.deepEqual(await withEnv(onPath(link, real, other), () => locateOnPath(NAME)), {
    command: copyLink,
    shadowed: [copyOther],
  });
  assert.deepEqual(await withEnv(onPath(first, real, link), () => locateOnPath(NAME)), {
    command: copyFirst,
    shadowed: [copyReal],
  });
});

/** A file symlink, or a skipped case where Windows lacks Developer Mode or elevation to make one. */
function fileSymlink(target: string, link: string, context: TestContext): void {
  try {
    symlinkSync(target, link, "file");
  } catch (error) {
    if (windows && error instanceof Error && "code" in error && error.code === "EPERM") {
      context.skip();
    }
    throw error;
  }
}

test("a symlink to the running copy is the running copy", async (context) => {
  const dir = scratch();
  const [a, b, alias] = [dir("a"), dir("b"), dir("alias")];
  const [copyA, copyB] = [copyIn(a), copyIn(b)];
  const copyAlias = path.join(alias, path.basename(copyA));
  fileSymlink(copyA, copyAlias, context);

  assert.deepEqual(await withEnv(onPath(alias, a, b), () => locateOnPath(NAME)), {
    command: copyAlias,
    shadowed: [copyB],
  });
  assert.deepEqual(await withEnv(onPath(a, alias), () => locateOnPath(NAME)), {
    command: copyA,
    shadowed: [],
  });
});

test("files that cannot run are not copies", async () => {
  const dir = scratch();
  const [folderNamed, inert, a, b] = [dir("folder-named"), dir("inert"), dir("a"), dir("b")];
  // A folder with the command's name, and a file that is not executable:
  // no exec bit on POSIX, no PATHEXT extension on Windows.
  mkdirSync(path.join(folderNamed, windows ? `${NAME}.CMD` : NAME));
  const file = path.join(inert, NAME);
  writeFileSync(file, "#!/bin/sh\necho 'fixture 1.0.0'\n");
  chmodSync(file, 0o644);
  const [copyA, copyB] = [copyIn(a), copyIn(b)];

  assert.deepEqual(await withEnv(onPath(folderNamed, inert, a, inert, b, folderNamed), () => locateOnPath(NAME)), {
    command: copyA,
    shadowed: [copyB],
  });
});

test("the launchers beside each other in one folder are one copy", () => {
  // npm writes codex.cmd and codex.ps1 together; with .PS1 in PATHEXT both match.
  const dir = scratch();
  const [a, b] = [dir("a"), dir("b")];
  const [aCmd, aPs1, bCmd, bPs1] = [
    path.join(a, `${NAME}.CMD`), path.join(a, `${NAME}.PS1`), path.join(b, `${NAME}.CMD`), path.join(b, `${NAME}.PS1`),
  ];
  for (const launcher of [aCmd, aPs1, bCmd, bPs1]) {
    writeFileSync(launcher, "");
  }

  assert.deepEqual(shadowedCopies([aCmd, aPs1, bCmd, bPs1]), [bCmd]);
  assert.deepEqual(shadowedCopies([aCmd, aPs1]), []);
});

test.runIf(windows)("on Windows a folder's copy is its first PATHEXT match", async () => {
  const dir = scratch();
  const [a, b] = [dir("a"), dir("b")];
  const copyA = copyIn(a, ".CMD");
  copyIn(a, ".BAT");
  const copyB = copyIn(b, ".BAT");

  assert.deepEqual(await withEnv({ ...onPath(a, b), PATHEXT: ".CMD;.BAT" }, () => locateOnPath(NAME)), {
    command: copyA,
    shadowed: [copyB],
  });
});

test("an installation found on PATH reports the copies it shadows", async () => {
  const dir = scratch();
  const [a, b] = [dir("a"), dir("b")];
  const [copyA, copyB] = [copyIn(a), copyIn(b)];
  const found = { kind: "available", via: "executable", command: copyA, version: "fixture 1.0.0" } as const;

  const probe = executableInstallation(ENV_VAR, NAME);
  assert.deepEqual(await withEnv(onPath(a, b), probe), { ...found, shadowed: [copyB] });
  // A bare-name fallback (morph's mistermorph) is a PATH lookup too.
  assert.deepEqual(
    await withEnv(onPath(a, b), executableInstallation(ENV_VAR, "oar-shadow-missing", [NAME])),
    { ...found, shadowed: [copyB] },
  );
  // One copy on PATH: no field.
  assert.deepEqual(await withEnv(onPath(a), probe), found);
});

test("an override or a fallback outside PATH reports no shadowed copies", async () => {
  const dir = scratch();
  const [a, b, outside] = [dir("a"), dir("b"), dir("outside")];
  const [copyA, copyOutside] = [copyIn(a), copyIn(outside)];
  copyIn(b);
  const found = { kind: "available", via: "executable", command: copyA, version: "fixture 1.0.0" } as const;

  // An override names the executable, as a path or a bare name.
  const probe = executableInstallation(ENV_VAR, NAME);
  assert.deepEqual(await withEnv({ ...onPath(a, b), [ENV_VAR]: copyA }, probe), found);
  assert.deepEqual(await withEnv({ ...onPath(a, b), [ENV_VAR]: NAME }, probe), found);
  // A fallback outside PATH (codex's macOS app bundle) is not a PATH lookup.
  assert.deepEqual(
    await withEnv(onPath(a, b), executableInstallation(ENV_VAR, "oar-shadow-missing", [copyOutside])),
    { ...found, command: copyOutside },
  );
});
