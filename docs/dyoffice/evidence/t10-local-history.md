# T10 phase 1: bounded native local history and selection

## Scope
Extends only the transport-free PPTX session. Existing default native engine/ops/render and setText whitelist are retained. No Web route, production writer, worker isolation, T06 persistence, identity policy or GUI is enabled.

Adds undo/redo of successful whole text batches using native slides/size/archive snapshots, following the existing Electron and transaction executor snapshot invariants (archive buffers are replaced, not mutated). Every successful apply/undo/redo advances local generation; stale, aborted, closed, rejected and empty-history operations do not. A divergent edit clears redo. Close releases both history stacks.

Retention is bounded to eight combined undo/redo points and a conservative 64MiB logical accounting budget (serialized slide model + entry names + all entry bytes, counted per snapshot). Oldest undo points are evicted first, then farthest redo points. This is NOT a hard RSS/CPU limit; serialization and transient copies still require T08 isolation before service exposure. Oversized current states reject edits before mutation. A successful mutation is also budget-checked; exceeding the budget restores the previous snapshot and preserves generation/history.

Selection returns detached local-generation, slide index/durable ID and optional top-level element durable ID/type. It does not grant authority, enumerate groups, return arbitrary text selection or bind a persisted revision.

## Validation
- Original source file checked against target GitHub blob 201deb8ad4e9a5f39318d90382ba3a5d688af508.
- Three initial new tests RED on missing undo/redo/selection; original tests remained green.
- Reviewer found post-edit budget growth could strand undo. A real nearly-64MiB inflated ZIP fixture reproduced acceptance on the old behavior; post-edit rollback fixed it. Initial fixture with 30KiB-per-part slack was insufficient, corrected to 20KiB slack and rerun RED/GREEN.
- Final native session 15/15 and existing worker roundtrip 2/2: **17/17**, zero skips. Actual native export/reopen and all package-part equality after full undo, divergence, invalid batches, eight-entry retention, cancellation and closure included.
- Independent reviewer reran final session 15/15 and found no definite limited-scope blocker.
- Focused strict TypeScript with existing repo raw/bidi ambient declarations passed. Initial omission of those declarations failed; no fake ambient types were added.

## Unpassed/unrun gates
Attempted full Slides directory serially: multiple suites failed before tests and Node 512MiB heap OOM; aggregate interrupted (130). Isolated history.test.ts failed resolving pngjs from tiff-decode.ts (zero tests). This is not evidence of a history product defect. Full monorepo/desktop/browser/PowerPoint/T06/PostgreSQL suites have not passed for this candidate. No installation or security setting was changed to hide those failures.

T10 remains open: browser canvas, authenticated scoped worker, immutable durable saves, images/shapes/page-order operations, full media/font relationships and external PowerPoint acceptance are outstanding. This local undo is not undo of a committed revision and cannot replace T14 durable command approval/recovery.
