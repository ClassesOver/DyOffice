# T14 controlled page and explicit recovery: proposed next phase

Status: design only, not approved for product mounting. Exact prerequisite #85
8aae9e704c2c6b3cfd1ac2a01d0034b1f82b13fe, on #84/#82/#81 dependency chain.

## Surface and isolation
A separate optional top-level page in a fresh realm. Do not load native App,
window.desktop, MCP bridge or legacy global write listeners. Preserve normal
editor navigation, never replace/convert a complex document. Reuse native
DocParagraph and the approved plain-text PM transaction adapter. Describe the
view as verified text, not WYSIWYG. An explicit capability check validates the
exact supported profile and current persisted bytes before showing actions.

## New session versus refreshed editor
Authenticate current session, read the persisted exact revision and acquire an
ordinary new-editor lease without takeover. Store only an opaque recovery pointer
(fileId, commandId, profile version) before a mutation can begin. No document text,
credentials, old editor ID, claim, inverse or upload request key is persisted in
browser recovery storage. Same-session refresh opens recovery first; it must not
restore old write authority. New login/session cannot automatically recover.

## State presentation
- No recovery pointer: load current bytes, validate supported profile, allow a
  single replacement proposal.
- Pending/approved: do not autoapprove or execute after refresh. Explicitly abandon
  the command before beginning a fresh proposal.
- Unknown/applied-uncommitted: show that local effect is unknown/not durably saved.
  Do not serialize, restage, reapply, recreate inverse or invent an idempotency key.
- Committed: use #85 verified historical receipt, explicitly distinguish a newer
  current revision; reload current durable bytes before new work.
- Abandoned/cancelled: the old command may no longer publish. This does not mean a
  mutation in a different still-open tab was visually undone. Reload durable bytes.

## Explicit abandonment protocol gap
#85 reader cannot perform writes. A separate optional server mutation must accept
only file/command ID plus the previously displayed digest, authorize current
owner/session and trusted fixed-tool policy, lock in the existing order, and
change only state via #84's guarded terminal transition. It must never expose the
stored envelope/old editor or turn a recovery read into execution permission.
Committed races return a freshly verified receipt, never claim abandonment won.
Exact implementation reuse versus a dedicated internal adapter awaits safety review.
Two transactions with stale read followed by a direct update are not acceptable.

## UI sequence
Review exact file/revision/paragraph old/new text -> explicit checkbox approval ->
separate Apply -> separate Save. One command at a time. Text rendering only;
profile and paragraph bounds checked server/adapter side. Before stage, exact
batch undo only. After stage/unknown, disable inverse and offer status query or
explicit fenced abandonment. After commit, no generic undo; a later revert is a
new approved action, outside first delivery.

## Verification gates
Optional unmounted authenticated routes with Origin/CSRF/no-store and bounded
schemas; malformed/cross-owner/new-session denial. Browser stale/dispose/repeated
click tests, reload with no original editor memory, explicit abandon versus save
race, lost responses, original receipt unchanged, unsupported complex documents,
real PG/S3 exact bytes and all unmodified parts, and a real browser if available.
Default-off assembly only; root reviews evidence before any product entry.

## Approved stage A implementation decision
Root authorized the standalone recovery-control phase. Independent safety reviewer
approved a single-transaction, private adapter reusing existing abandonCommand.
It accepts only fixed IDs and displayed digest, locks current authority, derives
its envelope internally, uses trusted current tool policy, and can call its
internal journal callback once for exactly those IDs. verifyCommit accepts only
the locked row/revision through historical provenance. Only a state-only change
to abandoned is written. Ordinary writer and its current-editor verifier remain
unchanged. New optional routes and DOM page only query/abandon; composing a new
approved text edit remains the next phase, not a claim of this delivery.
