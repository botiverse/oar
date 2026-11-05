# Codex compaction abort timing

The manual-compaction vendor fixture waited for the model provider request,
then expected `abort()` to be accepted. That request arrives through HTTP;
OAR learns the compaction turn identity through app-server stdout. The first
arrival does not establish that the second has been processed.

Two Windows CI failures retained this exact early refusal:

```json
{
  "kind": "rejected",
  "code": "busy",
  "reason": "Codex has not yet reported the compaction turn id required by turn/interrupt"
}
```

| Observation | Recorded order after compact was accepted | Follow-up |
|---|---|---|
| [PR #625, first attempt](https://github.com/botiverse/oar/actions/runs/41975009220/job/127071696793) | abort refused at seq 776; turn/started at 779; contextCompaction item/started at 780 | [Only the failed Windows Codex job reran](https://github.com/botiverse/oar/actions/runs/41975009220/job/127086468175), attempt 2 passed. |
| [PR #630, first attempt](https://github.com/botiverse/oar/actions/runs/41996285253/job/127140145055) | turn/started at 776; abort refused at 778; contextCompaction item/started at 780 | Original failure retained; no retry result claimed here. |

[Selected records](selected.json) preserve sequence numbers, receipt times,
control outcomes, and native turn/item identities. The source artifacts are
[PR #625](https://github.com/botiverse/oar/actions/runs/41975009220/artifacts/13391856732)
and [PR #630](https://github.com/botiverse/oar/actions/runs/41996285253/artifacts/13401310425).
Neither PR changed this fixture or the Codex abort path. After each assertion
failed, fixture cleanup released the provider and disposed the session; its
later completed compaction is not evidence of a successful abort.

OAR deliberately requires the native `contextCompaction` item before choosing
an interrupt target. A root `turn/started` alone could instead belong to an
autonomous goal. Its existing early `busy` refusal and product code remain
unchanged.

The fixture now waits up to 30 seconds for a new root `item/started` carrying the compaction item id and turn
id. It then makes one abort call and keeps the original acceptance, aborted
outcome, idle status, process survival, and subsequent-turn assertions. The
compaction deadline and 120-second case timeout are unchanged. The abort assertion also prints the full outcome and the records since dispatch,
so `code` and `reason` are visible directly in the job log. A missing item
fails the observation assertion instead of being accepted or retried.

## Reproduction and validation

The deterministic tests in
[`codex-session-stream.test.ts`](../../tests/codex/codex-session-stream.test.ts)
cover both notification positions, using a scripted app-server and virtual
time. Neither an older compaction item nor a child-session item releases the
wait. The matching new item authorizes one interrupt for its exact turn id;
its interrupted terminal leaves the session usable. Removing the observation
wait makes both cases fail. Existing tests separately require early aborts to
be rejected without sending an interrupt.

```sh
CI=1 pnpm vitest run tests/codex/codex-session-stream.test.ts tests/codex/codex-manual-compaction.test.ts
CI=1 OAR_TEST=codex-aimock pnpm vitest run sea-trial/vendor/manual-compaction.vendor.test.ts
```

On Linux x64 with native Codex 0.166.0 and a local scripted provider, the
focused unit run passed 28 tests and all eight applicable native compaction
cases passed. No real account or external inference was used. Windows
validation of the amended fixture remains a PR CI check; Linux success does
not replace it.
