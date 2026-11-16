# T14 same-session read-only command recovery

## Scope
Add an optional PostgreSQL reader after draft #84. No existing writer, migration,
HTTP route, application registration or editor code changes. This is not full T14
or a working browser refresh flow.

`createPostgresCommandRecovery({transactions, token}).lookup(fileId, commandId)`
requires the current authenticated owner/session with files:read and files:write.
The new factory accepts no editor ID. Its DTO contains only commandId, fileId,
state and digest; committed adds a verified precise historical RevisionRef.
It does not disclose arguments, claims, old editor/session, upload IDs or keys.

The reader locks existing account, file lifecycle and command rows after session
authorization. It never calls lockAccount (which expires uploads), touches a lease,
creates an account, writes timestamps or mutates commands. Trash and purging files
are rejected. Existing principal transactions recheck session deadlines before
commit. Authority is a transaction snapshot, not a grant for later writes.

For committed outcomes, a separate join validates the immutable command binding,
upload, revision commit and historical revision, including session, original
editor provenance, upload, request key, command source, base, epoch, hash and size.
The old editor is neither returned nor restored. The existing writer's receipt
verifier is unchanged and still rejects a new editor trying to verify the old
editor's save. Later file revisions do not replace the command's historical receipt.

## Verification log
- Initial missing-reader tests fail as expected (12 API assertions); this is an API
  red test, not evidence of a PostgreSQL semantics failure.
- First real PostgreSQL run: 14/15 pass. One test fixture incorrectly placed upload
  expiry before creation and violated uploads_check3. The fixture now moves both
  timestamps without dropping the constraint; no product fix was needed.
- Final real PostgreSQL + RustFS combined regression: **71/71**, zero skips,
  104 seconds. Includes 16 recovery cases, abandonment/upgrade, original journal,
  HTTP and revision commit suites.
- Command-related unit regression: **51/51**.
- Full server TypeScript: pass. Web boundaries: 1,000 files, zero violations.
- Existing writer/journal, routes and migration files are unchanged byte-for-byte.
- Independent reviewer completed static and evidence review: no remaining definite
  draft blocker. Reviewer checked final code and 71/71 log, but did not independently
  rerun PostgreSQL. All writer/service/routes/manifest files are byte-identical.

## Remaining work
No HTTP lookup/abandon operation, browser recovery pointer, controlled page or
refresh UX is mounted. Same-owner *new session* remains denied; recovery after
re-login needs a separate explicit policy and must not weaken RLS. A lookup never
resumes execution, restores inverse tokens, retries a commit or takes a lease.
Future controlled UI must use a fresh realm and durable bytes, retain normal editor
navigation, and distinguish unknown local effects from confirmed durable outcomes.
