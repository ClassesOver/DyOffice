# T09 native Sheets Web design

Active goal: complete the original T09 acceptance checklist, including actual
Excel reopen verification. User retains full session authorization and requires
no Docker. Work starts on `feat/t09-native-sheets` at T08 commit `beeded44`;
PR21 remains a separate integration proposal and is not silently rewritten.

Reuse the existing Sheets React App, Univer runtime, editing journals, tools and
bulk undo. Adapt desktop IPC to authenticated Web operations. The current App
uses `window.desktopApi`; add an explicit host seam as needed without forking the
editor or claiming unsupported desktop capabilities. Preserve semantic theme
and i18n rules in CLAUDE.md.

The existing xlsx-gateway and xlsx-package-io import Node filesystem APIs. Keep
those operations on the server, retaining the same mutation planner and Rust
archive writer. Browser requests identify owned files/revisions, never host
paths. Any native parse/read/recalc/save operation must use the T08 isolation
boundary. Editing output must retain T06 lease/CAS/idempotency semantics and
remain tied to the captured base revision. Do not replace the engine with a
convenient alternative library or substitute an unedited roundtrip for saving.

The implementation must cover formulas vs cached values, date/percentage/raw
numeric/unit semantics, defined names, charts, batch tool undo and unknown ZIP
parts. Test fixtures retain source hashes, expected edits and preservation
assertions. Browser acceptance must exercise the real mounted editor and server
save/reopen path. Regress xlsx-gateway and affected Sheets/native suites.

External Excel is a separate explicit gate. User will connect an Excel session;
none existed at initial discovery. Verify the generated workbook through that
session before closing T09; an internal parser passing is not Excel acceptance.

Read-only/unauthorized/conflict/lost lease states must disable mutation and never
silently overwrite another revision. Unsupported desktop and AI capabilities
must be explicit and preserve existing authorization boundaries. The exact
server session/job shape will be selected after tracing the original desktop
open/lazy-read/save lifecycle, rather than inventing a second workbook model.

Save transport now uses a prepared T06 upload: the server authenticates and
captures the base, validates the editor lease, maps the existing renderer request
with the shared desktop mapping, invokes the original mutation planner and
isolated Rust writer, then stages verified output through T06. No revision is
published by preparation. BrowserHost commits using its captured base/epoch and
retains the exact commit request on an unknown response. It must reconcile that
receipt before sending more edits, because structural edits cannot be replayed
against a newer revision. Native processing and browser requests are bounded;
lease takeover/revocation during processing prevents publication.
