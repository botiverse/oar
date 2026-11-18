# Qwen model-list authentication refusal

On Linux x64, Qwen 0.26.0 supports `get_available_models`. Both the machine's
standalone installation and its npm package answered when configured with a
synthetic local provider. The same control also passed on CI's 0.27.4. A new
version floor would incorrectly reject this supported query.

Without an authentication type, both versions exited 1 before answering
`initialize`. The cause was on stdout: a native `result` with
`subtype: error_during_execution`, `is_error: true`, zero turns, and the exact
message beginning `No auth type is selected`. OAR discarded this frame while
waiting for a control reply, then exposed the generic process-exit exception.
The original latency audit's operator separately confirmed its Qwen was logged
out; no real account was used to reproduce or fix the failure.

The reader now recognizes only that observed root startup refusal and returns
the existing model-list `unauthenticated` result, with fixed setup guidance.
It still closes the process, does not retry, and does not launch another query.
Unrelated errors remain errors. It does not classify arbitrary text mentioning
authentication or infer login state from an empty catalog.

[Selected native frames and public results](model-auth-2026-11-18.json) retain
the refusal and the successful configured replies. Public controls on 0.26.0,
0.27.4 and 0.28.0 each passed three cases: signed out, environment-only
configuration returning an empty catalog, and a settings-backed catalog
returning the native model and effort menu. Every case made zero provider
requests. Other authentication errors are outside this exact-match mapping.

Reproduce the public control with each installed binary:

```sh
OAR_QWEN_BIN=/absolute/path/to/qwen OAR_TEST=qwen-aimock \
  pnpm vitest run sea-trial/vendor/qwen-models.vendor.test.ts
pnpm vitest run tests/qwen/list-models.test.ts
```

The native test clears inherited credentials and uses separate temporary homes
and a local provider trap. It saves results under `oar-trial-run/qwen-models/`.
Unit controls also reject child results, non-error frames, later-turn results
and an unrelated extension-store failure instead of calling them signed out.
The existing timeout and cleanup controls still apply. CI runtime pins are
unchanged.
