# T14 fresh-realm controlled text editing (design)

## Goal and non-goal
Make one explicitly approved text replacement on an already persisted supported
LibreOffice template, then save through the actual T06 BrowserHost and verify the
durable receipt and bytes. Default-off experimental composition only. It is not a
normal App replacement, general DOCX editor, WYSIWYG preview, or completed T14.

## Approaches
Full native App mounting remains rejected: its persisted metadata/async/global
paths are not comprehensively fenced. A synthetic paragraph node would conceal
native behavior and is not sufficient evidence. Proposed selected approach is a
fresh top-level page using the real native DocParagraph extension, Editor and
approved-text-command adapter as a detached model, with an explicit text-only
controlled interface. The full App and window.desktop bridge are never loaded.

## Supported profile
Initially only the exact #82 LibreOffice template family, with its existing strict
ZIP/XML/relationship/part and text limits unchanged. Reject unknown or complex
packages before any command proposal or edit lease write. Keep every non-document
part and permitted paragraph wrapper byte-identical through the existing profile
export/reimport checks. Do not auto-convert, infer unsupported styles or normalize
whitespace. Optional strict five-part profile can wait rather than expand scope.

## Entry and lifecycle
Trusted composition supplies file ID; backend/session establishes ownership.
Read current RevisionRef and verified bytes, capability-check the profile, then
acquire a normal new-editor lease without takeover. No active native App shares
the realm or host. Use actual native DocParagraph with a detached Editor view so
keyboard/paste/drop cannot mutate it. Document edits only enter via approved
adapter compare-and-apply. canWrite depends on live host identity/lease, stable
profile, supported phase, no pending export/save, and non-disposal. Actual import
side effects and detached native behavior must be verified before this choice is
considered implemented.

All durable state in the page is its PM document and original immutable profile;
there are no App fonts, notes, HF, metadata setters or legacy event bridges.
Replacement input is transient candidate data, not serialized document state.
Generation comes from the document mutation fence, not a dirty React boolean.
Any profile/model reload destroys the old editor/adapter/executor and starts a new
identity; stale promises cannot update it.

## Single-command workflow
Choose a paragraph and enter replacement text. Show file ID, exact base revision,
original paragraph and proposed new text. Reject unchanged, invalid or out-of-
profile text before proposal. Server registry is a fixed trusted docs.replace_text.v1
descriptor, never provider-supplied. Snapshot exact anchors, expected text, argsHash,
file/base/lease/generation and command ID. No automatic AI approval.

Persist an opaque recovery pointer (file ID, command ID and profile version only)
before creating a proposal. A failure to save the pointer disables proposal/apply.
Only one active command. Explicit proposal -> checkbox approval -> separate Apply
-> separate Save. Candidate edits after proposal require cancelling/fencing the
old command first, never silently mutating approved arguments. Apply obtains a
single durable claim before a synchronous PM transaction. Unknown claim/response
never replays. Local effect is clearly marked uncommitted.

Before save starts, optional undo uses only the exact executor inverse and
server journal; no generic editor undo. It can be deferred from first delivery if
it complicates safe phase gating. Once staging begins, disable undo and all new
candidates. Serialize the PM paragraphs via the verified profile; capture and
recheck generation/identity before stage/bind/commit. Keep the exact coordinator
upload/hash/size/idempotency tuple in memory for same-page reconcile only.

## Recovery and durable success
After pagehide/refresh, enter #86 recovery control using only the opaque pointer.
Never restore old editor ID, claim, inverse or guessed save tuple. Read-only lookup
or explicit fenced abandonment is the only path; committed returns its exact
historical verified receipt. An abandoned command may have changed another tab's
memory, and stopping a request does not reverse its committed effects.

Saving is successful only after existing writer-context receipt verification and
exact durable revision confirmation. Reopen/download stored bytes, verify hash/size
and profile, and compare edited paragraphs plus all unmodified parts. A later
file head must not be confused with this command's revision. After verified terminal
state, a new editing session reloads current durable bytes with a new lease; no old
approval or inverse is reused. Do not clear a recovery pointer merely on an HTTP
success without verifying the matching state/command.

## Transport prerequisite
Before reuse, harden the inherited #75 command client with same-origin,
redirect:error, validated CSRF and streamed byte limits. Inspect the T06 host's
request wrapper for the same redirect exposure; use a narrowly tested trusted
same-origin wrapper or equivalent fix before any upload. Do not weaken receipt,
authority, lease or CAS checks to make GUI work.

## Validation gates
- Real native extension behavior, no App/global bridge, no browser input path.
- Exact profile rejects complex parts/relationships/text before proposals.
- Approval binding, repeated click, editing candidate after approval, expired or
  taken-over lease, external head advance, disposal and late server replies.
- Actual HTTP session/CSRF and T06 PG/S3 commit, rollback, lost response reconcile.
- Refresh at each uncertain phase routes only to read/fence; no duplicate command.
- Real Chromium normal explicit approval/apply/save and recovery negatives.
- Actual stored bytes reopened by profile and LibreOffice, with logical part diff.
- Independent review and root evidence approval before any production entry.

## Reviewed native transaction boundary
Because the existing adapter deliberately rejects editor.isEditable=false, use
editable:true only in a private detached view. Detached DOM alone is not the fence.
A narrow optional adapter dispatch hook authorizes the exact constructed Transaction
object after existing synchronous checks. A filterTransaction consumes that exact
object once; selection, storedMarks, plugin-appended and reentrant transactions do
not inherit authorization. Finally clears the capability on errors. Never hold a
boolean window around an async claim/execution. The default adapter dispatch remains
unchanged for existing consumers. First delivery omits undo controls and uses
explicit recovery/abandonment for uncertain outcomes.

The real DocParagraph import has a known top-level performance-wrapper side effect
on ProseMirror prototypes; it is not claimed side-effect-free. Verify this isolated
fixed stack in the fresh realm and do not import App or global desktop bridges.

## Pointer-not-found limit
If a pointer was durably written but proposal never reached the server, recovery
404 is intentionally indistinguishable from another/new session. Keep the pointer
and block automatic controlled re-entry; do not guess a session proof or clear it
silently. The page may offer copying non-secret recovery IDs and a fresh normal
editor link, never reuse the old host or take over a lease. Current phase does not
support manual pointer deletion or pretend the command was cancelled. Fully
resolving this case later needs a separately reviewed admission/pre-registration
protocol, not a relaxed reader. State this limit rather than claim full closure.
