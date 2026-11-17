# PPTX one-shot command scope correction

## Confirmed defect

The private one-shot processor advertised `roundtrip` and `setText`, but forwarded
any `setText.ops` batch to the session's broader operation whitelist. That session
also supports slide insertion/deletion and notes changes. A text-only envelope
could therefore produce non-text changes. The old negative deletion test used a
one-slide deck; it passed because the engine rejects removing the last slide,
not because the command boundary excluded deletion.

New real-engine tests reproduced successful `addBlankSlide`, `setNotes` and
`deleteSlide` inside a `setText` envelope. The deletion case first constructs and
reopens a real two-slide archive, and independently confirms the session can
remove one slide. A mixed text/structural batch with invalid package bytes also
proves rejection must occur at command capture, before package parsing.

## Correction and preserved boundary

Command capture now requires every operation in a `setText` batch to be exactly
`setText`, rejecting the whole batch with the existing `INVALID_OPERATION` error
before native work. The existing session still validates targets, paragraph/run
fields, payload size and operation semantics. Its broader editing vocabulary is
unchanged, as are the limits, cancellation and output structural reopen checks.
A valid text operation on the two-slide fixture succeeds and preserves both pages.

This is not an enabled PPTX endpoint. `buildLocalApp` still rejects formal Slides
mounting with `PPTX_OS_ISOLATION_UNAVAILABLE`. The unified production boundary
remains unavailable; its current PPTX command contract supports outline only.
A supported isolated edit/export runtime, complete command/artifact protocol and
execution-to-T06 integration are still prerequisites for formal PPTX availability.
No ordinary-fork fallback, broker, route, runtime gate or migration is changed.

## Provenance and tests

Relevant source/test/session/typecheck config baseline Git blobs were checked
against target `f8facfc3afb51b9fc12e01ed45b4ded4cb279b06`. Work used an isolated
snapshot, not an assertion that every unrelated target file was rematerialized.

- RED: new 4 regression cases failed, existing 15 passed. They rejected resolved
  forbidden mutations or observed parser failure instead of early command denial.
- Initial GREEN: one-shot and session suites 48/48 passed.
- Final focused/full/typecheck results are reported separately after completion.

Only trusted generated fixtures are passed to the actual engine in these tests.
They are functional/schema evidence, not OS isolation, browser visual, PowerPoint
compatibility or production acceptance.

Final focused run: one-shot, session and original worker roundtrip **50/50 passed**
(3 files, no skips). PPTX worker strict TypeScript passed and whitespace checks
passed. Root `npm test` was actually attempted: it stopped at html2docx browser
startup (`features.test.ts`, `pagebg-restore.test.ts`, Chromium/crashpad failure),
not a passing full suite. A separate full Slides attempt was stopped after seven
suites reported zero executed tests due an import/setup failure. Isolated
`edit-fidelity.test.ts` reproduced Vite `Denied ID` for the existing
`packages/pptx-ops/src/prompts/ops/text.md?raw` import; no test body ran. No Vite
filesystem gate, browser sandbox, assertion or dependency was weakened to bypass
that environment limitation. Other reported zero-test suites were edit-ops,
slide-script, generate-deck, slide-media-ipc, redact-ui and durable-identity.
