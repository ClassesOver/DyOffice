# T01 final bounded acceptance

Date: 2026-11-16. Source baseline: `6f3702a514fbfdfcecec6746c9614a2ae0784369` (merged #42), with T00 accepted through #43. This record accepts the original T01 shared-contract / BrowserHost-skeleton scope, not later editor or authorization tasks.

## Checklist evidence

| Original T01 item | Evidence |
| --- | --- |
| Unknown methods, malformed Problem DTO, missing versions, oversized events, secret fields | `apps/web/test/unit/host-contract.test.mjs`: 19 tests, including two final explicit regressions for unknown adapter methods and missing protocol/UTF-8 byte limits. Existing tests cover malformed error DTOs, revision/generation/lease/hash requirements and allowlisted output fields. |
| RED from absent contracts | Historical RED/GREEN for missing exports, roles and Problem decoder is retained in [checkpoint](t01-browser-host-checkpoint.md). Final regressions were also mutation-tested: exposing arbitrary adapter properties and removing protocol validation produced 2 test failures (not an environment error); implementation restored before final GREEN. |
| Shared types, validation, fail-closed host, desktop compatibility seam | `packages/web-contracts/src/{api,host,events,tools,errors}.ts`, `packages/browser-host/src/index.ts`; compile-time positive/negative fixtures in `host-contract-types.ts`. The partial adapter is an explicit seam; unsupported methods cannot claim success. Existing Electron renderer/preload behavior is preserved, not reimplemented as a fake Electron bridge. |
| GREEN, typecheck, no browser Node dependency | Commands and exact results below; source boundary scan covers 600 files, not an empty mirror. |
| Commit shared contract implementation | Contract work was delivered in #31, selectable unit command in #42; this closeout adds regression evidence and records original checklist acceptance. It does not require renaming historical commits to the plan's suggested subject. |

## Fresh local checks

Executed on Node v24.22.1 in an isolated copy. All ordinary tracked baseline blob hashes matched the remote tree before edits; the pre-existing `native/xlsx-engine/target/release` build-output symlink was absent and is outside these contract checks. Existing installed dependencies were reused; this was not a fresh install.

- `npm run test:web:unit -- host-contract.test.mjs`: 19 passed, 0 failed.
- `npm run test:web:unit`: 45 passed, 0 failed.
- `npm run typecheck:web`: exit 0 (contract/browser and server configurations).
- `npm run test:web`: 229 passed, 1 existing optional skip, 0 failed.
- `node tools/check-web-boundaries.mjs`: 600 files, 0 violations.
- `node tools/dyoffice/compatibility-baseline.mjs --check`: 84 inputs unchanged; this is source compatibility, not runtime roundtrip evidence.

The two added tests do not require product behavior changes: they explicitly lock down existing safeguards. The mutation was temporary and is not part of this change. All restored implementation blobs match the baseline.

## Scope and exclusions

The original T01 is a skeleton milestone. `Principal`, `RevisionRef`, `OpenFileResult`, `SaveInput`, `ToolDescriptor`, `ToolCall`, `ToolOutcome`, `CommandEnvelope`, `JobRef`, `CapabilityCatalog`, `PublicSettings` and `Problem` are present. This does not mean every downstream service implements them.

- `getCapabilities()` represents unsupported/read_only/editable and downgrades advertised capabilities when required adapter functions are absent. Function presence is not proof of native-file roundtrip correctness.
- Envelope and DTO projection excludes unknown top-level fields. Event payloads and human-readable error strings are not recursively scrubbed; downstream producers/consumers must enforce their own schemas and safe messages.
- Authenticating principals, permission checks, actual AI/MCP/data-source execution, event dispatch, four-format editor integration and durable saves remain separate task gates.
- Whole-monorepo and real-browser suites were not rerun for this closeout. Historical blocked attempts remain recorded. No production or capacity claim is made.
- Repository Actions remain disabled. The owner's latest instruction excludes CI from this merge gate; no new CI result or automated-review approval is claimed.
