# Upgrading an executable below the adapter's version floor

2026-11-16, Linux x64. An upgrade button must be able to act on the old
executable that discovery refuses. This change belongs to installation/update
contracts and the native updater adapters. Sessions and other readers keep
requiring `AvailableInstallation`.

## Findings

| Runtime and starting version | Native observation | OAR consequence |
| --- | --- | --- |
| Antigravity 1.4.9, floor 1.5.0 | `agy update`, with no stdin or terminal, exited 0; the same path then reported 1.5.9. The OAR probe/check/upgrade/probe sequence also changed `version_unsupported` to `available`. | Preserve `via` and `command` in the version refusal; admit it to checks/upgrades and expose native `agy update`. |
| DSH 0.2.1-rc.4, floor 0.2.1-rc.5 | `--help` and the published CLI parser expose profiles and plugin management, not a self-updater. A positional `update` is a profile name. | Preserve the old command in discovery; leave upgrade/check members absent. The package is managed through its documented npm method. |
| Pi 1.3.0, RPC floor 1.4.0 | `pi update --self --no-approve` upgraded an isolated global npm prefix to 1.5.2; the same executable path reported the new version. No prompt or account was needed. | Native support exists, but OAR's selected-command discovery must be fixed before connecting it. Current `installation()` reports bundled even for custom subprocess commands, which can include a host wrapper plus prefix arguments. The bundled SDK remains a host dependency. |

No inference requests, accounts or existing installations were used. Only
Linux x64 was measured. The AGY source was the official 1.4.9 archive:

- [Google archive](https://storage.googleapis.com/antigravity-public/antigravity-cli/1.4.9-4962164969177088/linux-x64/cli_linux_x64.tar.gz)
- SHA-512: `96a259b7475ae70a5b002ea8a83b804bba9b6ad2171af0cd0839b3959d9e6046ba36e181bc2d5597522aeceaacc06023564c46232fdb958f26f8c72267d9f0fd`

The updater, not OAR, selects and verifies the new release. The observed
1.5.9 is evidence, not a pinned update target. This did not run the user's
original 1.2.7 binary and does not establish how every older updater behaves.

## Reproduce

Extract and verify that archive, then run:

```sh
node --import tsx experiments/old-cli-upgrade/antigravity.ts /path/to/antigravity
python3 experiments/old-cli-upgrade/package-controls.py
```

The first command copies the supplied binary into a temporary HOME, drops
inherited account/configuration variables, and exercises OAR's public runtime
methods against the official release service. It deletes the copied
installation afterwards. The second installs the two old npm packages in a
private global prefix, inventories their help and runs only Pi's self-update.
It also deletes the prefix afterwards. Both commands use the network and
write only their disposable installations; they make no model requests.

## Evidence and limits

- [Antigravity result](antigravity-result.json): complete public OAR result
  sequence, with the temporary path replaced by `<isolated>/agy`.
- [Pi result](pi-result.json): old version, native update help, update outcome
  and new version. Only temporary paths are replaced.
- [DSH command inventory](dsh-commands.json): native version and help. The
  published `@deepseek-ai/dsh@0.2.1-rc.4/lib/bin.js`, `parseDshArgs`, confirms
  that every non-flag first token except `plugin` expands into `--profile`.
  No hypothetical `dsh update` command was run.
- Pi's published `@earendil-works/pi-coding-agent@1.3.0/dist/package-manager-cli.js`
  (`handlePackageCommand`, update branch) and `dist/config.js`
  (`getSelfUpdateCommandForMethod`) identify the native updater and its npm
  prefix selection. The command delegates to npm itself; OAR did not run npm
  as a substitute updater.

Full package archives and command logs remain local; these files retain the
observations cited above. No credential values or account identifiers appear.

The regression uses a real child executable with a local release response.
It failed before the fix, then verified old discovery, check without mutation,
upgrade, and new discovery. Separate controls keep the refusal after a no-op
or failed updater. A newer version is not automatically compatible: hosts must
re-probe and require `available` before opening sessions.
