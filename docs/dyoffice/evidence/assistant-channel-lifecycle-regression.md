# Office channel lifecycle follow-up (2026-11-17)

Baseline: PR #134 head `a5a8d181fab4191bbf6e9c69cb7a2bae59ccfed7`.
Source files were fetched at that immutable revision through the connected repository API. This is a focused source subset, not a complete checkout or a merge candidate.

## Changes

- Paused collaboration holds completed peer continuations; a later unpaused snapshot resumes exactly once.
- New Chat invalidates pending channel creation and connection replies, so old replies cannot resurrect the former conversation or create a scheduler. If a connection reply arrives after reset/disposal, disconnect that exact connection ID/epoch on a best-effort basis. This is not proof that an unreachable server has completed cleanup.
- Late delegation acknowledgements check the captured local generation, channel and executor before requesting yield; they cannot yield a replacement chat executor. The remote task may already exist, and no claim of rollback or cancellation is made.

## Verification

Environment: Node 24.22.1, npm 11.9.0, existing local `tsx` dependency.

```
node --import tsx --test apps/web/test/unit/assistant-channel-client.test.mjs apps/web/test/unit/assistant-channel-contract.test.mjs
```

Result after independent review fixes: 24 passed, 0 failed, 0 skipped (22 client, 2 protocol). Original client baseline: 13 passed. Added tests reproduced pause/new-chat/late-ack failures before fixes; stale connection cleanup assertion separately failed then passed.

`npm test` was attempted using the exact PR head root package.json. It could not run: `No workspaces found: --workspace=@genoffice/i18n`, because this source subset does not contain the complete workspace. This is not a full-suite pass. Full typecheck, editor/browser E2E, real harness calls and model continuations were not run here.

## Remaining scope

This patch does not complete server-side Office parent `waiting_peer`, nested peer questions, a second real harness adapter, or full editor E2E. It does not enable collaboration by default, widen tool permissions, change database migrations, or change data/artifact access. PR base conflicts still require integration and tests on the integrated tree.

## Independent review follow-up

Review reproduced two additional defects: an old refresh promise blocked initialization of a new conversation, and concurrent/repeated starts created multiple server connections. Review also identified stale execution cleanup that could hold or clear the new conversation's run slot.

Fixes now scope refresh error/finally and pump error/finally to the originating generation. Reset detaches old async latches and run state; abort is still requested, but an executor ignoring it cannot block a newly registered, idle executor. Native executor `isBusy()` remains respected. Start is single-flight within a generation and reuses an already established connection. Tests cover old refresh success/failure, old finally against a pending new refresh, concurrent/repeated starts, and stale execution settlement while a new run remains active. Four added reproductions were observed failing before the fix; the pending-new-refresh test additionally protects the generation latch.

This does not prove the old executor actually stopped, does not roll back executed work, and does not make unknown remote outcomes safe to retry.
