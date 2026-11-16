# T14 command safety core

Base: feat/dyoffice-web 10793fcdc93f033c33a886434be35f3a6d83733d.

The user delegated implementation choices and requested safe parallel progress. This slice supplies the testable authorization/approval state machine without enabling a new write endpoint. Provider output remains untrusted. T13 and T12 files and migration numbers are not changed.

## Design

Use existing CommandEnvelope, with payload exactly `{toolName, arguments}`. Canonical JSON hashing is bounded and rejects non-JSON input. The approval digest binds the whole envelope and the trusted registry descriptor. Every command operation reauthenticates through a journal-provided, transaction-locked authority check scoped to deployment/user/session; write dispatch additionally compares file revision, editor generation and lease epoch. A journal transaction must atomically create/transition a command. Dispatch durably records unknown_outcome BEFORE calling the editor, never retries ambiguous effects, and validates state again immediately before synchronous application. Only verified T06 receipts may mark committed. Undo is not general editor history: it is a batch-specific inverse guarded by the exact post-apply generation.

Alternatives: directly execute model tool calls (rejected: no approval); memory-only production journal (rejected: crashes could replay writes); injected durable journal with no default (chosen: testable safe core, explicit integration gate).

## Plan

- [x] Test approval binding, stale version/generation/lease, duplicate IDs and unauthorized scopes before implementation.
- [x] Implement bounded hashing and immutable command records with required atomic journal storage.
- [x] Test crash/unknown, committed cancellation, receipt mismatch, and undo after newer edits.
- [x] Implement BrowserHost adapter requiring explicit server claim and synchronous compare-and-apply/inverse.
- [ ] Run targeted tests and strict types; independent review; publish draft only.

## Not complete in this slice

No default memory journal, PostgreSQL table/adapter, HTTP approval route, UI preview, actual editor tool registry, or automatic Provider execution. Durable restart/real browser/T06 end-to-end acceptance and the full T14 plan remain open. No migration number is reserved. These integrations are mandatory before exposing this core to users.
