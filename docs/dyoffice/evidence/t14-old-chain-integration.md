# T14 old-chain integration boundary

Target inspected initially: `feat/dyoffice-web@d6ab6e4a6dc37234e48acfe9979e8514cf88d8aa`. Publication rebased onto `bf38ebadeda8c9e06b30bb439137a79fc22567dc`; #79 changed workspace/settings without overlap with these 45 new files. Its updated contracts, preferences and workspace server sources were refreshed for the final targeted check.
This is selective integration of useful experiments, not a merge of the old stacked branches and not production activation.

## Disposition

- #77: target #102 already owns the mutation fence and native atomic text primitive. Keep the newer `dispatchAuthorized` exact-transaction gate. Preserve the JSON-only host-owned store experiment, React concurrency regressions, and explicit serializer-input inventory; do not mount this generic store in App or replace the later per-field save-intent migrations.
- #80: #123 already owns the opt-in engine core-property option, with default and privacy semantics unchanged. The target coordinator already owns serialized Buffer bytes and its snapshot regression; the existing session-file transport regression is also identical and is not rewritten. Preserve the restrictive five-part DOCX profile, synthetic ancillary experiments, snapshot regression and authenticated PostgreSQL/T06 save proof. No general Word compatibility claim.
- #82: preserve the fixed LibreOffice-template profile, actual fixture and narrow save/reopen tests. This is not a broad LibreOffice importer or desktop visual acceptance.
- #87: preserve only audited unique controlled-editor/QA experiments, using current target transport/command service. Do not bring ancestor implementations back, enable an ordinary App write entry, or add compatibility paths.

## Already-absorbed files deliberately not overwritten

- #77: `document-mutation-fence.ts`, `approved-text-command.ts`, the native/fence tests and web approved-text tests are already integrated through #102. The target adapter includes the later exact `dispatchAuthorized` gate.
- #80: `command-save.ts`, its Buffer regression and engine `patch.ts` are already integrated; #123 supplies the core-properties option and stronger portable engine tests.
- #87: `apps/docs/tsconfig.json` already permits explicit TS imports. The current command service and journal/state regressions already verify committed receipt provenance, including original editor, missing binding, replaced command and hash mismatch. Current HTTP command code/tests already cover CSRF syntax, same-origin/no-redirect policy, bounded UTF-8 streaming and disposal cancellation. Current session-files transport and its regression are retained, including newer target behavior. Old comment/formatting-only changes are discarded rather than replayed.
- #82/#87 unique source, fixtures, experiments and supporting evidence are integrated as listed in this change; no ancestor branch is merged wholesale.

## Current reruns

After #79 refresh: all three PostgreSQL persistence files rerun together: 16/16, zero skips; full Docs TypeScript exit 0. No target changes were reverted.

- Integrated seven Docs test files (JSON store/concurrency, serializer inventory, simple/LibreOffice profiles and controlled editor/model): 88/88 after the style-profile fix.
- Full Docs TypeScript check: exit 0. The historical React act-environment global assignment needed an explicit typed-safe Object.assign; rerun passed.
- Retained target HTTP command/session transport/command-state regressions: 36/36.
- Buffer-view coordinator regression: 1/1. Existing core-preservation and document-properties engine regressions: 29/29.
- Real PostgreSQL + ProseMirror + authenticated HTTP + T06: 6/6, zero skips. Normal/lost response, post-approval edit, lease takeover, ancillary and ancillary-lost response covered. Uses local object storage, not RustFS. Disposable instance stopped after run.

- Additional real PostgreSQL persistence checks for the LO profile and native controlled editor: 10/10, local object storage, zero skips.
- QA helpers: 11/11; controller typecheck and QA build exit 0. QA initialization single-flight regression first reproduced three documents for three concurrent loads (expected one), then passed on an isolated PostgreSQL instance after the fix. Neither QA host is production-mounted.

Independent review found that merely validating the styles root admitted hidden text via default styles. Five regressions first failed (16 existing passed), then the simple profile was restricted to one exact audited style table. No blacklist or wider compatibility fallback was added. The seven-file suite passed 88/88 after this fix; independent review reran the original malicious payload (now rejected), simple-profile 21/21 and the full seven-file 88/88 suite, and found no remaining blocker for this unmounted experimental batch. Historical evidence documents retain their original dates/counts; they are not current acceptance reports.

## Remaining product gates

The entire native App still lacks a unified ownership contract across all persisted inputs, DOM substories and asynchronous producers. A static 52-input serializer guard is not a proof of complete mutation coverage. Metadata fixes for page color, mirror margins and even/odd headers remain intact and are not generalized by this experiment.

No actual browser/WPS/LibreOffice GUI roundtrip, openEuler isolation, RustFS rerun or full repository acceptance is claimed here. The unified isolation plan remains authoritative for future production enablement. CI execution is not a merge prerequisite per owner; no CI settings are changed.
