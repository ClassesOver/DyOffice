# SaaS editor parent continuation wiring

Follow-up to the separately documented Office parent ledger slice. Base PR #134 `9f269bc9`; no desktop shell or T16 Home assistant entry is added.

## Runtime wiring

Docs and Sheets call optional `beginRun` immediately before their existing native AgentLoop starts, after pending preparation/generation checks. The returned opaque token is settled from that run's completion/error callbacks. No server parent is created for ordinary nondelegating chat.

The first actual channel delegation lazily creates the owner/connection-bound parent using a stable request ID and original user goal; subsequent children reference that parent. The real AgentLoop's safe-yield result posts the recorded parent claim and child IDs. Reverse scoped reads wait until the yield receipt releases the durable Office run slot.

When the parent becomes claimable, the client claims it once and queues its original goal plus bounded, explicitly untrusted child evidence through the original native editor queue. The continuation token is carried in Docs queue metadata and Sheets pending continuation metadata. Unrelated native user work can run while the continuation waits; its completion cannot settle the claimed parent. A paused, cancelled or reset queued token cannot start a new model run. When a running related parent is cancelled, paused, fenced or loses authorization, only its captured executor/run token is cancelled; unrelated native work is not stopped. A late cancellation response cannot submit an old parent result into a replacement channel. A subsequent delegation/yield round reopens only the same parent after its confirmed yield receipt.

## Verification

- Client lifecycle unit tests: 29 passed. Native-parent entry and parent-yield-slot race and reset-during-cancel were observed failing before their fixes.
- Real PostgreSQL 17 + Fastify HTTP injection + real AgentLoop deterministic transport: native Office→peer→reverse Office read→native user request interleaved→parent continuation→second delegation/yield→final continuation. No external model endpoint is called. One new integration case plus parent/store suite: 16 passed, 0 failed, 0 skipped.
- Real tests use an independently initialized disposable local cluster on 127.0.0.1:55436, stopped afterward; no production database is involved.
- Docs TypeScript check: exit 0.
- Sheets TypeScript diagnostic with `--allowImportingTsExtensions`: exit 0. This flag does not represent the unmodified default script passing.

## Boundaries

This is deterministic native-loop/HTTP/DB integration and editor wiring, not a browser E2E or real upstream model/harness acceptance. No claim is made that a lost claim response can be automatically rerun or that reconnect resumes an already running job: unknown outcomes still require reconciliation. Existing paused/offline/unavailable states do not gain authority, production feature flags remain unchanged, and external scoped document reads keep their existing narrow tool list.

## Review correction and regressions

Independent review identified missing cancellation propagation into an already running native parent. Added a captured, token-scoped cancellation callback; Docs and Sheets compare the token with their active native run before cancelling the real loop. Both cancel-requested and authorization-failure tests failed before the fix, then passed; an unrelated native run remains unaffected. The real HTTP/PostgreSQL/AgentLoop integration also now confirms a task-card parent cancellation terminates the held model stream and produces durable cancelled state.

Docs assistant regression: 32 passed. Sheets assistant regression: 83 passed.

A broad root `npm test` attempt stopped with failure in `@genoffice/html2docx`: `tests/features.test.ts` and `tests/pagebg-restore.test.ts` could not launch Chromium in this environment. It did not reach the CLI suite. No security settings were changed, no blocked external-runtime suite was retried, and this is not a whole-repository pass. Subsequent verification is limited to controlled local fixtures.

Final SaaS integration reran the unmodified `typecheck:web:docs` and `typecheck:web:sheets` commands successfully, with no extra diagnostic flags. The combined native-parent/channel PostgreSQL suite passed 20 tests, and the final Web unit suite passed 560 with 3 installed-runtime skips. Default four-format SaaS build also passed.
