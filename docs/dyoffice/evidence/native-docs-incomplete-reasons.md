# Native save incomplete-reason diagnostics

Base: #134 `f74419dc979c10cea11d95c53a9289fa01e87a50`.
The exact-head DOCX job `133976011474` passed seven cases and failed only the
normal roundtrip clean-state assertion. Saved bytes contained the expected text,
table and clipboard content. The native acknowledgement was `incomplete`.

The same four fences remain: PM document identity, metadata snapshot, password
intent and font-settings version. This diagnostic reports only their names and
changed metadata field names, never field values, document text or credentials.
It does not clear dirty, automatically save again or weaken any browser assertion.
The acknowledgement carries optional reasons to the existing bounded DOM/debug
output. Empty reasons still do not imply success. The precise CI race remains
unresolved pending the next normal browser run.

TDD: the real native-save racing-content test failed before reason propagation.
Final controlled checks: production Tiptap/save/bridge control and content/metadata
races plus original metadata-race suite 46/46; Web bridge 3/3; Docs types passed.
Content races leave newer text out of persisted bytes and keep the editor dirty;
metadata races report only `metadata,pageCount` field categories and remain dirty.
No Chromium or external model runtime was invoked locally.
