# T01 BrowserHost contract checkpoint

> Date: 2026-11-15
> Branch: `feat/dyoffice-web`
> State: partial, not a T01 milestone acceptance.

## Delivered

- `packages/web-contracts/src/api.ts`: explicit four-format metadata, revision/save DTO and runtime guards.
- `packages/web-contracts/src/host.ts`: BrowserHost interface and explicit unsupported/read_only/editable capabilities.
- `packages/web-contracts/src/events.ts`: protocol-v1 event decoder and 256 KiB payload limit.
- `packages/web-contracts/src/errors.ts`, `tools.ts`: typed error vocabulary and tool execution descriptors.
- `packages/browser-host/src/index.ts`: adapter boundary; unsupported calls fail instead of pretending an editor is available.
- `apps/web/test/unit/host-contract.test.mjs`: five contract tests.
- `.github/workflows/dyoffice-web-boundaries.yml`: includes the new host contract tests in addition to T00 checks.

## Evidence from isolated validation

Executed with Node v22.16.0 and TypeScript 5.8.3 in a temporary source mirror:

```sh
node --experimental-strip-types --test apps/web/test/unit/host-contract.test.mjs
# 5 passed, 0 failed

node --test tools/check-web-boundaries.test.mjs
# 2 passed, 0 failed

tsc --noEmit --strict --target es2022 --module nodenext --moduleResolution nodenext --allowImportingTsExtensions \
  packages/web-contracts/src/{api,errors,events,host,tools}.ts packages/browser-host/src/index.ts
# exit 0
```

These tests ran against matching isolated source files, not a full dependency-installed repository checkout. The standalone T00 boundary script was also invoked in its T00-only mirror; it scanned zero application files, so its success is **not** evidence of a whole-repository browser-import pass.

The GitHub remote was checked after writing the files; the remote head then was `d14a7bcc3adc9e0bc5a8c9d5a25d6e8b535ed390`.

## Explicit remaining work

- [ ] Integrate the new interfaces with four real editor renderer entrypoints and map all preloads/IPC calls; current adapter contains no actual document reading/writing implementation.
- [ ] Add browser-capability tests for supported operations, unknown desktop method calls, and all credential-bearing payloads; the current tests cover only a minimal happy/error subset.
- [ ] Add a Web-specific TypeScript build configuration and project-wide typecheck job, then rerun the checks in a full checkout with the actual lockfile.
- [ ] Run `npm run test:web`, the Web CI job, and all affected GenOffice upstream suites in a full checkout.
- [ ] Validate the file revision/lease/CAS contract server-side before enabling document saves. The current runtime guard does not implement access control or version transactions.
- [ ] Complete T00's four-format IPC/native component inventory. T00 and T01 are **not** marked complete.

## Decision

Proceed with the existing GenOffice Agent Core and editor-local tools. Keep provider keys and access policy on the server. Do not enable a format merely because its `CapabilityState` type can express `editable`; only a real adapter with successful native-file roundtrip tests may advertise that value.


## Continued work (2026-11-15)

- Fixed the capability adapter so an advertised `editable` format cannot be exposed as usable when read or save operations are absent. Missing read methods now resolve to `unsupported`; missing save methods cap a readable format at `read_only`.
- Enforced expected personal preference value types before returning browser-facing settings, instead of merely filtering property names.
- Added `packages/browser-host/src/ai-transport.ts`: an `AgentTransport` adapter to the planned POST `/api/v1/ai/turns` SSE endpoint. It maps ordered `delta`, `reasoning`, `tool_call`, `phase`, `usage`, `stop_reason`, `error`, `done` events, terminates once, aborts an in-flight request and sends an explicit cancellation request. It does **not** include any provider credentials.
- Added `tools/audit-web-host.mjs` and tests to enumerate typed public preload APIs and renderer method calls across all four formats. Its results are source inventory only, not a validated implementation mapping.
- Registered new Web workspace package entries (including existing `apps/web`) in the root `package-lock.json`; validated JSON structure and preserved the ordering of unchanged entries.
- The separate Web CI workflow now invokes BrowserHost tests, SSE tests, import boundary tests, and the IPC inventory scanner.

**Fresh isolated verification:**

```text
node --experimental-strip-types --test apps/web/test/unit/host-contract.test.mjs apps/web/test/unit/ai-transport.test.mjs
12 passed, 0 failed

node --test tools/audit-web-host.test.mjs
3 passed, 0 failed

node --test tools/check-web-boundaries.test.mjs
2 passed, 0 failed
```

These results come from mirrored/fixture source files under Node v22.16.0; the GitHub-hosted CI and whole-repository installation/build/test gates have **not** been verified green. The SSE endpoint and cancel route are planned server APIs, not yet implemented; no browser editor has been connected to them. The current front end therefore must not claim AI editing works. Real authenticated streams, saving/rollback, concurrency and four-format roundtrips remain open.

## Contract completion candidate (2026-11-16)

This update supersedes the earlier counts and missing-contract notes, not the
historical evidence. It remains a candidate until exact-head CI passes.

- Added required principal roles, an opaque `JobRef` identity, and the planned
  `CommandEnvelope` fields. `isCommandEnvelope` checks the version/generation/
  lease/hash metadata shape; it does not compute argument hashes, approve commands
  or authenticate callers. T08 owns endpoint-specific job status DTOs.
- Added `Problem` and `decodeProblem`: malformed error fields fail closed, and
  unknown fields such as stack/credentials are excluded from the returned DTO.
  Server-authored detail/error strings still require safe server-side messages.
- `decodeHostEvent` now projects only the documented envelope fields. Payloads
  remain event-specific data; this is not a general recursive secret scrubber.
  T17 producers/consumers must validate payload schemas before dispatch.
- Added compile-time positive/negative examples for all missing types to the Web
  typecheck. Kept PR #21's optional `OpenFileResult.name` for compatibility.
- The existing Web CI already executes `host-contract.test.mjs` and
  `typecheck:web`; no new unsupported command is claimed. The original plan's
  `test:web:unit` alias is still not present: the exact command is below.

Verified in an isolated candidate based on target `3dc6046`, plus a separate
combination with the pending PR #21 integration source (Node v24.22.1):

```sh
node --experimental-strip-types --test apps/web/test/unit/host-contract.test.mjs
# Before changes: 14 pass, 3 new regression failures. After: 17 pass.
npm run typecheck:web
# Browser contracts plus PR #21 server typecheck: exit 0.
node tools/check-web-boundaries.mjs
# 588 files scanned, 0 violations in the combination source.
```

The type fixture also failed before implementation with the expected missing
exports/roles diagnostics, then passed including `@ts-expect-error` negative cases.
Independent review reran all 17 host tests successfully. After refreshing the
parallel local-shell source files, the combined Web API suite passed 205 tests
with 1 existing skip; this is a local combined candidate, not exact remote CI.

A whole-repository `npm test` was attempted. It stopped in `@genoffice/html2docx`
at `tests/features.test.ts` and `tests/pagebg-restore.test.ts`: Chromium could not
create its process-singleton socket (Operation not permitted), with crash-report
paths read-only. This is not a full-suite pass and does not establish browser E2E.

Latest observed target CI at `3dc604610a3fdb427cfe31d05a874cb764279e77`:
[Web boundary run 43799429056](https://github.com/ClassesOver/DyOffice/actions/runs/43799429056)
failed at checkout with `Repository not found` / git exit 128; host/typecheck/build
steps were skipped. Rerun the exact published candidate before T01 acceptance.

Four-editor feature completion, authenticated event dispatch, durable save
semantics and approval execution are later task gates. Types or DTO projections
do not prove those paths are implemented or authorized.

### Refreshed onto merged PDF target

After #29 merged, rebased the candidate tree onto target
`9410065e1cfb3be421c30b9e3a846c5477dbb606`. Its exact base tree
`b6623ccd0a18bafa4b31a5f67946f49c6701ac97` was independently matched before
applying only these eight T01 files. Fresh verification: host contracts 17/17,
`typecheck:web` exit 0, Web API 198 pass / 1 existing skip. This base does not yet
contain the pending #21 runtime, whose separate combination is recorded above.

## Selectable unit command acceptance supplement (2026-11-16)

Base: target `474ce46a0e4878ffc9903a56e96d2242da04f13c`; all tracked source blobs independently matched before edits. This supersedes only the earlier missing-command note, not historic CI failures.

- `npm run test:web:unit -- host-contract.test.mjs` executes the actual `.mjs` source: 17/17 passed. The original plan's nonexistent `.ts` example is corrected, not silently aliased.
- No selector executes all existing Web unit tests: 39/39 passed. One or multiple exact basenames supported; unknown, traversal and Node CLI selectors fail closed rather than silently executing a different suite.
- Runner regressions: 3/3; CI command/path regression was RED before workflow wiring, then GREEN. The Web workflow now invokes the same documented command and watches runner-only changes.
- `typecheck:web` passed; boundary scan traversed 129 browser-reachable files with zero Node/Electron violations. The Node test runner resides under tools, outside browser runtime.
- Existing `test:web`: 198 pass, 1 pre-existing optional skip. This is not a fresh install or whole-monorepo test claim.
- Only root script metadata changes; no dependency/version change. Compatibility manifest refresh must differ only in root package.json hash/size.

These are local candidate results. Exact published candidate CI remains required before claiming T01 accepted. Shared DTOs do not implement future authenticated AI dispatch, approval execution or four-editor workflows. T00 dependency acceptance remains separately coordinated.

Additional local verification: tools regressions 29/29, Web production-build/HTTP smoke 2/2. Independent reviewer reran runner 3/3, selected contracts 17/17 and all unit 39/39. Compatibility refresh was compared structurally and changes only `files.package.json`.

The complete root `npm test` was also attempted: preceding packages passed (27, 384, 65 and 9 tests; DOCX engine 2239 passed/1 existing skip), then `@genoffice/pdf2docx` was terminated with `Killed`/exit 137. The command did not finish, so this candidate has **no whole-monorepo green claim**. This was outside the unit-command change; no test was weakened or removed. Local dependencies were reused, not a fresh install.


### Target integration

Rebased onto merged #32 target `9b2c7aa587ab403935a46ae1f43ea8e326c84547`, exact tree `0497e30318ef2776b800ad194631a10dfa060148`. All tracked source blobs were verified before applying only the command delta. Preserved the complete three-job host/runtime/real-service/browser workflow and new account code. Prior local counts above remain scoped to old baseline; combination results follow separately. Actions disabled at repository level, unchanged. No merge or CI success is claimed.

Combination verification on the merged #32 source: selectable Host17/17; all Web unit43/43; CI/runner10/10; typecheck:web passed; boundary600/0; compatibility84/0; existing Web229 passed/1 existing optional skip. Independent review verified that the workflow diff is exactly two path-filter additions and the Host command substitution, preserving all three jobs and real-service gates. Corrected the plan table's old Vitest label to the actual Node.js runner.

The first Web run in the isolated copy omitted workspace-local dependency directories and incorrectly resolved root yauzl, failing auth-only-admission/docs-mount/pdf-cmap-safety. Restoring read-only reuse of the already installed apps/web and apps/pdf dependency directories made the unchanged tests pass; no dependency or test was modified to suppress this failure. Still not a fresh install. Exact new-head CI remains unavailable while repository Actions is disabled; prior safety-review merge refusal remains in force.

### Current integration decision (2026-11-16)

Integrated documentation-only target `2c9003f4a429ebb29a67371891e4cc3bcf829ab6` without reverting T00's bounded acceptance or its final runtime evidence. The owner's later explicit instruction excludes CI from the merge condition; earlier CI-required statements above are historical, not a claim of a new CI pass. Local verification and absence of conflicts or actionable review findings remain required. Automated reviews were quota-blocked and are not approvals. This command-only PR does not by itself mark every T01 checklist item complete.
