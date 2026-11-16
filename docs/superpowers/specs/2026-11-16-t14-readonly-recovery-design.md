# T14 same-session read-only recovery

## Intent and approved boundary
Recover an authoritative minimal command outcome after a page reload without restoring the old editor's write authority. Parent approved this narrow continuation after #84. This is an optional server module, not a mounted endpoint or full reload/user-interface solution.

## Approaches
- Reuse the previous editor ID in the writer: rejected because an old tab may still exist and a read must not recover its mutation capability.
- Relax the existing receipt verifier: rejected because live write/save verification intentionally binds the current editor.
- Separate read-only provenance lookup: selected. Trusted database binding identifies historical editor provenance internally. No editor identity is accepted or returned.

## Contract
`createPostgresCommandRecovery({transactions, token}).lookup(fileId, commandId)` authenticates the current same owner/session with at least the existing command outcome scope (`files:write`). Canonical UUID inputs only. Cross-session, cross-owner and absent commands have the same not-found behavior. No new credentials or grants.

Lock order follows session authentication, existing account, file lifecycle, command. Existing account is locked by SELECT only: do not call the upload-cleaning lockAccount helper. No lease acquisition, renewal, command mutation, upload cleanup or updated_at writes. Purging/inaccessible files fail closed. Trash behavior is stated by the implementation and verified.

Return only commandId, fileId, state, digest; committed additionally returns its precise historical RevisionRef after complete verification. Do not return envelope/arguments, claim, operation, session/editor IDs, upload ID or idempotency key. Unknown states and malformed committed records fail closed.

Committed provenance joins the command's immutable binding, upload, revision_commit and file_revision. It checks owner/deployment/session/file/command, binding editor against upload editor, base revision, lease epoch, source command, upload ID, idempotency key, sha256, size, committed upload state, revision source=save and parent revision. Current file head may have advanced: the returned receipt is the historical command revision, not the new head. Existing writer receipt checks remain byte-for-byte unchanged.

## Non-goals / limitations
No HTTP, browser recovery storage, approval/abandon UI, automatic retry, lease takeover, inverse resurrection, cross-session recovery or general Word support. The caller cannot use the DTO as authorization for a write. Session reauthentication creates a different session and does not grant historical recovery. A returned snapshot cannot promise authority remains live after the transaction; every future operation reauthenticates.

## Validation
Real PostgreSQL tests cover refresh/new-editor read versus unchanged old writer rejection, final commit/abandon snapshot under locks, revoked session waiting on locks, same-owner new session/cross-owner denial, lifecycle and historical revisions, malformed provenance and read-only database state. Independent review precedes publication.
