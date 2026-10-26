/**
 * Native login-shell environment controls, using temporary configuration and
 * a synthetic marker only. Prints no environment values or profile output.
 * Run: pnpm tsx experiments/user-shell-environment.ts /bin/bash /path/to/fish /path/to/nu
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { userShellEnvironment } from "../packages/oar/src/shared/shell-environment.js";
import { runExecutable } from "../packages/oar/src/shared/executable/index.js";

async function probe(shell: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "oar-shell-probe-"));
  try {
    const name = basename(shell);
    const configs: Record<string, readonly [string, string]> = {
      bash: [".bash_profile", "export OAR_SHELL_PROBE=from-login-profile\n"],
      zsh: [".zprofile", "export OAR_SHELL_PROBE=from-login-profile\n"],
      fish: [".config/fish/config.fish", "if status is-login; set -gx OAR_SHELL_PROBE from-login-profile; end\n"],
      nu: [".config/nushell/login.nu", "$env.OAR_SHELL_PROBE = 'from-login-profile'\n"],
    };
    const config = configs[name];
    assert.ok(config, `No isolated profile fixture for ${name}`);
    const [file, source] = config;
    await mkdir(join(dir, ".config", name === "nu" ? "nushell" : "fish"), { recursive: true });
    await writeFile(join(dir, file), source);
    const result = await runExecutable(process.execPath, ["--import", "tsx", import.meta.filename, "--child"], {
      env: { ...process.env, HOME: dir, ZDOTDIR: dir, XDG_CONFIG_HOME: join(dir, ".config"), SHELL: resolve(shell), OAR_SHELL_PROBE: "inherited" },
      timeoutMs: 15_000,
    });
    assert.ok(result.ok, `${name}: environment probe failed; output deliberately withheld`);
    console.log(`${name}: login profile observed, inherited environment unchanged`);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

if (process.argv[2] === "--child") {
  const before = { ...process.env };
  const result = await userShellEnvironment();
  assert.equal(result.env.OAR_SHELL_PROBE, "from-login-profile");
  assert.equal(JSON.stringify(process.env) === JSON.stringify(before), true, "host environment changed");
} else {
  const shells = process.argv.slice(2);
  assert.ok(shells.length > 0, "Pass the absolute paths of the shells to verify");
  await Promise.all(shells.map(async (shell) => { await probe(shell); }));
}
