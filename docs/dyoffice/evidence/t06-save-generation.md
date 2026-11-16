# T06 local save-generation guard

Baseline reviewed: `21b0abbb3f7593b3837642ab23db76777c8e9f03`. The current HTTP file host is read-only and has no persistent save/revision service. The DOCX worker is implementing local open/edit/download; this change does not modify or claim server saving for it.

## Bounded design

`packages/browser-host/src/save-generation.ts` is independent client bookkeeping, not a replacement for PostgreSQL CAS, idempotency, fencing, authentication or immutable storage. No BrowserHost contract, server route or capability changes. It is not yet connected to an editor. Keeping it isolated avoids misleading the UI while the persistence service is absent.

- Call `markEdited()` for every local and AI mutation.
- Call `beginSave()` together with synchronous capture of the snapshot to serialize; do not capture old bytes, await, and then begin a newer generation. It returns a frozen ticket bound by object identity to this guard's one pending save.
- Call `settleSave(ticket, 'committed')` only after a verified durable HTTP commit or explicit server reconciliation. It marks only that ticket's generation saved. Edits made meanwhile remain dirty.
- Explicit rejection/conflict uses `failed`, leaving edits dirty. Lost responses and ambiguous network failures use `unknown`; the pending ticket remains and blocks blind new saves until reconciled. Transition from unknown to failed only when the server authoritatively confirms no commit occurred. This module does not itself reconcile or retry.
- Call `reset()` only after accepting an authoritative opened snapshot (including file/session switches). This invalidates pending callbacks; it must not be used to dismiss conflicts or claim a download was saved to the server.
- `getState()` returns a detached snapshot with generation/savedGeneration/dirty/status. Do not read dirty alone to present an unknown outcome as successfully saved.

## Verification

Six focused Node tests cover edited-during-save, known failure, duplicate/foreign/forged tickets, reset with matching generation, unknown outcome and single-flight, immutable ticket data, detached state, and invalid runtime completion inputs. Tests were written before the implementation; an additional null-completion failure was reproduced then fixed. Command:

```sh
node --experimental-strip-types --test apps/web/test/unit/save-generation.test.mjs
```

The current CI lists Host/SSE/HTTP tests individually and does not yet run this new file. The commands above and the combined unit glob were executed locally; a CI step must be added before claiming automated coverage. TypeScript strict standalone checking passes; the module has no imports or Node dependencies. Independent security review found no blocking issue and reran all six tests. Combined Web unit tests passed 31/31, boundary checker tests 10/10, and Web TypeScript checking passed. Root monorepo npm test remains blocked at i18n because its Vitest dependency is absent in the Web-only environment.

Later, the Web boundary workflow gained a step for this file. The guard is still client bookkeeping. The server transaction is recorded in [t06-revision-commit.md](t06-revision-commit.md). Browser end-to-end coverage of the full Docs ribbon remains open.
