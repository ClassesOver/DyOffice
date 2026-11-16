# T09 XLSX request snapshot safety (limited adapter scope)

Target inspected: feat/dyoffice-web at bc7f509; GitHub returned xlsx.ts blob d568513e7085aad8e37164804299da5de4d0d3db. PR #67 remains an unaccepted systemd gateway isolation candidate; this change does not bypass or replace that boundary.

## Reproduction
The native adapter validates readRange/recalculate arguments synchronously but retains caller-owned references across admission and native open/index waits. Two deterministic process-adapter tests changed a one-cell range to the full worksheet and changed an edit after invocation. Both failed on original code, showing mutated values reached the request boundary.

The fix snapshots edits, read arrays, and nested ranges before native admission. It is specifically protection against subsequent modification of ordinary data objects, not a getter/proxy defense or authentication mechanism. It changes no isolation settings, database behavior, external endpoints or default routes.

## Evidence
- Original code: two new snapshot tests failed on wrong transmitted arguments.
- Candidate: three tests passed, including existing input-limit rejection before admission.
- Strict focused TypeScript passed.
- Independent reviewer ran the two snapshot tests successfully, no blocker in this ordinary-object scope.
- No systemd, real native engine, browser, or Office acceptance was performed.
- Ordinary commands were initially blocked before startup by /tmp tmpfs ENOSPC (4.9 GiB used, 32 KiB available). Explicit reviewed command execution operated only on this isolated workspace candidate and its dedicated temporary directory; no other task data was removed.
- Full aggregate command result is recorded in aggregate.log; it is not a T09 real-host acceptance.

T09 remains open. Save-plan ownership and other native operations are not covered by this bounded change.

Aggregate attempt: `npm test` did not execute tests: i18n's two files failed import because the reused isolated package snapshot lacks root `tsconfig.base.json`. This is an incomplete aggregate verification environment, not a product regression or a passing suite. No claim of full Web/monorepo validation.

Follow-up verification: copied the isolated package sources and root TypeScript configuration into this task's workspace, and supplied existing server mjs helpers for admission tests. Final targeted plus admission suite: **16/16, zero skips**, independently repeated **16/16**. New tests alone **3/3** independently repeated. Final focused strict TS passed.

The repaired aggregate `npm test` executed earlier packages and reached html2docx, where `features` and `pagebg-restore` failed to launch Chromium because `socket() Operation not permitted`. html2docx reported 41 passed/70 skipped, two failed files. This is not an aggregate pass. Exact current target xlsx.ts at 9c6067e5af6323ec30a79146c53f3af6e48a37d0 is byte-identical to the original inspected source. Aggregate sources remain the isolated older snapshot, not a claim of complete current-target integration.
