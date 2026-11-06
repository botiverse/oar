# Kimi account selection through the CLI environment

On Linux, OAR 0.90.0 and real Kimi 2.4.1 select the account named by the CLI
process's `KIMI_CODE_HOME`. Both `oar usage kimi` and
`oar orient kimi --depth account` already support this without an `--env` flag.
This addresses the reproducible account-selection claim in issue #655; it does
not establish how the reporting host selected an account or stored its verdict.

## Evidence

The probe performs two native device logins against a local OAuth/model server,
which writes two isolated Kimi homes with different synthetic access tokens.
There are no real accounts, model prompts or external quota requests. All
subsequent CLI processes share the same inherited environment except
`KIMI_CODE_HOME`; their ordinary HOME is a separate, unauthenticated directory.
The built CLI is invoked without an environment flag.

| Selected home | Usage identity | Weekly used ratio | Usage rateLimited | Orient readiness |
| --- | --- | --- | --- | --- |
| A | Fixture A | 1 | true | rate_limited |
| B | Fixture B | 0.25 | false | ready |
| A again | Fixture A | 1 | true | rate_limited |

For each selection, the probe checks usage JSON, orientation JSON and the
orientation text table. No login endpoint is called during these reads.
[Selected results](kimi-accounts-evidence.json) retain synthetic identities and
request paths only. No credential values or machine-local paths are published.
The identities are fixture labels, not real account details.

## Reproduce

```sh
pnpm install
pnpm run build
OAR_KIMI_LOGIN_COMMAND=/path/to/kimi-2.4.1 \
  pnpm tsx experiments/orientation/kimi-accounts.ts
```

The same assertion runs as a native regression with
`OAR_TEST=kimi-login OAR_KIMI_LOGIN_COMMAND=/path/to/kimi-2.4.1 pnpm vitest run
sea-trial/vendor/kimi-login.vendor.test.ts`. Its CLI entry is the
source entry, while the standalone probe exercises the built entry. Both run in
separate Node processes and inherit the selected account environment.

## Host behavior and limits

The command examples and PowerShell equivalent are in
[orientation](../../docs/spec/orientation.md#cli-and-verification). PowerShell
syntax is checked against Microsoft documentation; this run is not a Windows
execution result. No first-party login, actual exhausted subscription, token
refresh, alternate Kimi version or other runtime is claimed by this probe.

A usage verdict describes the account that was probed. Hosts must key stalls by
runtime and selected account/configuration, not just runtime ID. Native identity
fields are optional and a display name need not be unique. A host already knows
which isolated configuration it selected and should retain that association.
