# T14 controlled text workflow: proposed GUI assembly

Status: DESIGN ONLY. No product mount, router change or default write enablement.
Based on draft #82. Requires parent approval and the safety gates below before code.

## Intent and scope

Provide a visible path to propose, approve, apply and durably save one supported
text replacement without replacing the normal native editor or claiming general
Word editing. First supported files are the two explicitly reviewed profiles:
strict simple-DOCX and the fixed LibreOfficeDev text-template family. Unknown
packages, structures, formats, whitespace cases or settings remain rejected.

The user sees the file name, exact base revision, supported-profile label, paragraph
text, exact old/new replacement and state. This is explicitly a text-only review,
not a visual/formatting preview. The existing native editor remains the normal
route for opening and editing other documents. No provider is needed for phase 1:
a human enters a replacement candidate. Future AI output may populate a candidate,
never approve or execute it.

## Approaches and recommendation

1. Reuse the entire native App in place. Rejected for this phase: its 52 serializer
   inputs, direct refs/metadata edits and asynchronous handlers lack a complete
   shared fence. isDirty=false or host.readOnly=true does not establish isolation.
2. Mount the App read-only beside a controlled panel. Rejected in the same realm:
   window.desktop, retained asynchronous closures and global handlers remain;
   current bridge.dispose revokes URLs but does not fence outstanding saves.
   A separate sandboxed, write-incapable preview frame is possible later but adds
   substantial protocol/lifecycle/GUI verification and is not the first delivery.
3. Recommended: a separately loaded controlled page, with no native App import or
   window.desktop bridge. Reuse native DocParagraph/PM, the audited atomic adapter,
   mutation fence, authenticated session host, approval client, journal and T06
   coordinator. This reuses tested native components while preserving the existing
   native editor route, rather than pretending that route is already fenced.

The parent asked to prioritize native reuse, not require unsafe same-realm reuse.
This recommendation is a design choice awaiting confirmation, not an implemented
or user-approved change to navigation.

## Entry and authority

- An explicit optional entry from the document list, not an in-place switch out of
  an active editor. Label: “受控文本修改（仅支持已验证模板）”. It loads a new page/realm.
- Do not automatically close or destroy an existing editing page. Existing dirty
  or unknown-save work must be resolved there; no inference of clean state from
  the native bridge alone. Normal browser leave warnings remain, not a replacement
  for a generation contract.
- The controlled page reads authenticated bytes for one exact RevisionRef and
  checks byte size/hash and profile before constructing its PM state or proposing
  a write. An unsupported result explains why and offers the unchanged normal
  editor route. It never attempts lossy conversion or falls back to a weaker profile.
- Create an independent editorId and acquire the lease normally. No automatic
  takeover. If another editor holds it, display read-only conflict and ask the user
  to finish/release that editor. Lease loss freezes proposals/execution/save.
- Bind current file/revision/lease/generation. Avoid importing hidden editor APIs,
  native MCP/global handlers or a generic execute-tool dispatcher.
- Server composition uses one fixed trusted descriptor, docs.replace_text.v1,
  normal session+Origin+CSRF and transaction authorization. Keep the new route and
  UI behind an explicit deployment option with default disabled. A browser flag
  is not an authorization boundary and cannot choose the server descriptor.

## Editing and approval

- Supported paragraphs are shown as text; the user selects a range within one
  paragraph and enters a replacement in a separate candidate field. The base PM
  document is not generically contenteditable: no arbitrary paste, format, newline,
  drag/drop or browser history-undo mutation channel in this first UI.
- Convert selection to stable PM from/to + expectedText. Validate supported
  replacement semantics before proposal. Candidate fields never mutate document.
- One command at a time. Freeze candidate/range after a server proposal; changing
  them cancels the pre-execution proposal and requires a new digest/review.
- Show old/new text, file and revision. Require review checkbox, explicit Approve,
  then a separate Apply button. Never auto-approve a provider or auto-execute an
  approved command after navigation/recovery.
- Execute with durable approved->unknown claim and final synchronous PM authority
  check. Only the atomic adapter mutates the controlled PM document.
- Applied state reads “已应用，尚未保存”. A separate Save button serializes through
  the selected profile, checks generation around awaits and performs stage/bind/
  commit with one immutable tuple. Show saved only after exact durable receipt.

## Save, undo and unknown states

- Before apply: Cancel records cancellation. It is not an undo operation.
- Applied, not staged, live matching generation: “撤销本次未保存修改” uses only the
  recorded batch inverse and journal undo claim. Never call generic PM/App undo.
- Once staging/binding/commit starts, freeze all mutations and disable undo until
  a definitive safe outcome. The backend transaction arbitrates save/undo; the UI
  must not pretend an asynchronous undo also rolls back an upload or durable save.
- After committed: no in-place Undo button. A persisted revert would be a new
  separately approved operation or the existing revision-history workflow; it is
  not part of this first delivery. Open normal editor via a fresh durable revision.
- Ambiguous apply/report/bind/commit replies enter a visible unknown state. Never
  apply again, serialize another document, mint another idempotency key or call a
  fresh commit. Only query outcome / reconcile the original tuple as appropriate.
- Native window Close/Refresh cannot be absolutely blocked. beforeunload is only
  a warning. Recovery must be designed and verified before any product entry.

### Mandatory recovery work identified in current code

The present coordinator keeps pending tuples only in memory. ToolExecutor also
keeps the inverse/claim context locally; existing outcome replies do not expose a
recovery handle for a fresh page. Therefore simply mounting the existing modules
would not constitute an acceptable refresh/crash story.

For first release, introduce a bounded opaque recovery record (fileId, commandId,
profile/version; no credentials or document bytes) persisted before dispatch, and
an authenticated read-only recovery lookup scoped to the same owner/session.
This lookup must return the existing journal/receipt status without new approval,
lease takeover, arbitrary file access or new mutation. Reauthentication across a
new session is an explicit unresolved boundary; never silently broaden session RLS.

After reload:
- committed + exact durable receipt: show saved and permit a fresh open;
- pending/approved: display review-required state; do not auto-apply;
- unknown/applied without trustworthy local PM/inverse: show unresolved status,
  do not replay or invent undo/commit, and offer only read-only outcome checks and
  durable-file access until the explicit abandonment path below completes;
- known pending T06 tuple: resume only if recovered from trusted durable binding,
  matching all source/bytes/idempotency fields. Do not rebuild it from guessed data.

### Proposed explicit abandonment (requires a new reviewed durable transition)

For a lost local PM state or an unknown response, offer “弃置尚未提交的命令”, not
“撤销”. Explain that this prevents later publication of that command; it neither
rewinds arbitrary local edits nor reverses an already committed revision. Require
an explicit user click and outcome check. Restrict it to the fixed live-editor
text command, never generic external-effect tools.

Under the existing principal/account/file/lease/command lock order, the server
must arbitrate abandonment with bind/commit/undo atomically. If a verified commit
already won, return that receipt and do not abandon. Otherwise record an explicit
terminal abandoned-uncommitted state/tombstone and make every later bind, report,
commit and replay fail for that command. Preserve the bound upload reference and
let normal expiry cleanup handle objects; no permanent deletion is part of this
operation. A new forward migration and real concurrent commit/abandon tests are
mandatory; do not retrofit an applied command into the old pre-apply cancelled
transition or call it a successful undo.

For phase 1, a freshly loaded page is recovery-read/abandon only for the old
command. It must not reuse an old editorId or resume a pending commit merely from
reconstructed client fields, since an old page could still be alive. Same-page
unknown saves keep their exact in-memory tuple and may reconcile. Once durable
abandonment is confirmed, a new page may start a new independently approved command
from the current durable revision and a normally acquired lease. No automatic
takeover or replay. Revoked/replaced sessions stay denied; cross-session recovery
is not silently introduced.

This recovery endpoint and transition design require independent review and real
crash tests. Until then, a GUI may run only as an explicitly labelled test fixture,
not as a normal document-list entry. Do not call the persistent applied-but-lost
local result “cancelled” or “saved”.

## Verification gates

1. Capability rejection and exact part preservation on actual retained fixtures.
2. Session/CSRF/cross-owner and same-session recovery isolation; fixed registry.
3. Explicit review/approve/apply/save clicks, repeated clicks, keyboard activation,
   range/candidate changes, Escape/cancel and malicious candidate HTML rendering.
4. User edit/selection generation changes, lease expiry/takeover, dispose and late
   async responses; no stale mutation or new staged upload.
5. Bind/commit lost replies, exact receipt reconciliation, definite 409, same-byte
   old revision, save/undo arbitration and page reload at every boundary.
6. Actual GUI in a fresh real browser context and reopened saved DOCX. Test
   controls must never be available in the product bundle. No external provider
   call, uncontrolled document or production data is required.
7. Independent final code review, targeted TS/build and relevant regressions. If
   the native dependency build cannot run, report the blocker; no generic textarea
   replacement presented as successful native editor integration.

## Staged deliverables

A. Approve this isolation/state/recovery design. B. Implement recovery primitive
and route assembly behind default-off configuration, with real PG crash/race tests.
C. Add a test-only GUI harness using the same components, verify actual browser
flows and Office reopen. D. Only after evidence review, consider the explicit
normal-list entry. None of these stages closes general-native-App T14 migration.
