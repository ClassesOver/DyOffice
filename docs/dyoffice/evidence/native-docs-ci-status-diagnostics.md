# Native DOCX CI status separation and diagnostics

Base: PR #134 head `52777966`. Evidence: Actions job `133965858704`.

The roundtrip TLS fixture routes HTTPS requests but does not attach a WebSocket
upgrade handler. Live notifications therefore reconnect. The backoff callback
only rerenders the notice; it does not observe a remote head or mark a draft dirty.

Two delayed-save tests expected the dirty save-status plus the download link as
one parent string. The live notice legitimately changed that composite string.
The persistence and notification messages now have separate spans. Tests still
require the exact persistence state, including an empty state for dirty edits.
All existing revision, saved-byte, preserved-part and newer-edit assertions remain.

The first normal-save case is **not yet explained/fixed**: the CI log first showed
`Editing` plus the reconnect notice, then only the notice. A real local Tiptap +
production `file-actions.save` + Web bridge + DOCX file write control stayed clean
after the native acknowledgement, and a later edit became dirty without changing
saved bytes. This does not reproduce the full Chromium table/clipboard path.

A bounded diagnostic records native acknowledgement outcome and dirty state in
the persistence span; failed clean assertions print only these enum/boolean values
and whether a notification exists. No document text, identifiers, URLs or tokens
are logged. Native accepted acknowledgement is not itself proof of HTTP success;
the existing guard still preserves an unknown HTTP outcome. No retry, extra save,
state reset, or relaxed clean assertion is introduced to obtain a green result.

Local evidence: bridge contracts 3/3; real native-save control 1/1; Docs TypeScript
check and roundtrip syntax check passed. No Chromium/external AI invocation was
attempted. Full browser verification and the first-case root cause remain pending
normal CI, which must not be reported as already passing.
