# Harness late-response cancellation (plan E)

A response can arrive after its task signal was aborted but before the client has
acquired the body reader. The old early abort check rejected the operation without
cancelling that response body. The caller saw cancellation while the stream and
underlying HTTP connection could remain open.

The shared harness data client now explicitly cancels a body received in this
window and preserves AbortError even if asynchronous stream cleanup rejects. The
existing reader-phase cancellation, size/hash verification, atomic non-overwriting
file publication and temporary-file cleanup are unchanged. No receipt, committed
artifact, task scope, or external source permission is modified.

Verification uses only synthetic data and loopback HTTP. A deterministic stream
regression first failed because cancel was never called. A second real localhost
HTTP regression first failed because the unfinished response stayed open after
cancellation. Both pass after the fix; the focused harness-data file passes 12/12.
The localhost fixture closes its listener/connections and both cases assert no
partial output and unchanged pre-existing committed file bytes. A rejecting stream
cancel callback does not replace AbortError. No external model, Codex process,
full CLI suite, browser, or external data source was invoked.

This closes the late-body cleanup gap only. Existing offline receipt recovery is
not reimplemented, and these tests do not establish complete plan E/G acceptance.
