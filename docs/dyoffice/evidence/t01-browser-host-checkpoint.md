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
