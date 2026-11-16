# T10 phase 1 follow-up: ambiguous element references

Depends on exact #92 180a493fe7872108e58de0d5153c42f4c46712b4. Only the local transport-free session changes. No route/worker/T06/browser mount.

The engine durable ID uses the first eight GUID characters and accepts parse-time/cNvPr aliases. A real PPTX with two distinct complete GUIDs sharing a prefix reproduced selection silently choosing the first matching element. Selection and apply now reject more than one match across all native reference aliases. Every member of the text batch is checked before runTxn, so an earlier valid edit cannot partially apply before a later ambiguity is rejected. Unique existing aliases remain compatible; missing targets retain existing rejection behavior.

Validation: initial actual native fixture failed on #92 because selection resolved rather than rejecting. Final session17/17 + existing native worker roundtrip2/2 =19/19; strict focused TypeScript passed. Independent reviewer checked product code and reran the preceding16-case session suite successfully; reviewer requested an additional cross-alias/whole-batch test, which was added and passed locally. Re-invoking the reviewer for that final extra test was blocked by agent thread limit; do not claim independent17/17.

The extra test initially counted the root spTree cNvPr as a target; corrected to preserve it and change only the two real elements. An initial import from pptx-ops failed because matchesElementRef is not re-exported there; corrected to the existing pptx-engine/identity subpath. Failures were not suppressed.

Ordinary exec later failed before command execution because /tmp was full. Read-only diagnostics found no temporary PPTX files owned by this task. Tests used the workspace TMPDIR through approved elevated execution. No security settings or other workers' files changed.

Full Slides/monorepo remain unpassed as recorded in #92 (missing pngjs and heap limit), no browser/PowerPoint/PostgreSQL rerun. This change prevents ambiguous targeting in this seam; it does not change global upstream IDs, add group/text selection, or complete T10.
