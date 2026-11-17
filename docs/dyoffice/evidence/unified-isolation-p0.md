# Unified document isolation: control-contract stage

This is an unconnected foundation, not a runtime sandbox or production release. It follows PR #126. Source mapping was made against `d6ab6e4a6dc37234e48acfe9979e8514cf88d8aa`; before publication the relevant parser, worker, editor, application-registration and production-guard blobs were checked unchanged at `b9dd28f0ed562e739e79b80dd43a2f9669ebcdab`.

## Implemented

- Exact-key immutable document request/profile metadata; all four profiles remain experimental and production-disabled.
- Control handle/renew/adopt/stop/instance structures; systemd InvocationID is canonical 32-character lowercase hex. Trusted PostgreSQL authorization remains outside these syntax checks.
- Artifact envelope binds the trusted pending request, complete instance, command and generation; it does not prove the bytes or authorize T06 commit.
- Source-backed command schemas cover read-only PPTX outline and XLSX session close. Replies have strict nested schema, bounded size/count/path/font fields and unambiguous slide identities. Other engine commands remain denied. XLSX close validates its real Rust success frame against trusted current engine-session mapping; it never proves OS termination or releases a reservation.
- Local pending-outline/close gates snapshot expected context/deadline, validate before one-time consumption, and reject duplicate or expired replies. This is not durable replay recovery or permission revocation enforcement.
- PDF rotation operations have a standalone payload validator; it accepts no document bytes, proves no parsed PDF properties, and adds no runtime command.
- Source-backed entrypoint/reachability inventory and command disposition map distinguish browser workers, API parsers and future OS sandbox work.

A test-only one-shot outline coordinator now exercises trusted authority pre/before-start/post/return checks, fixed-key reservation grants, instance binding, bounded execution, confirmed-stop release and uncertainty retention. Default factory always refuses, and the test factory requires both actual test environment and an explicit unsafe-test option. Fault tests cover late side effects, false/failed ledger acknowledgments, cancellation races and wall-clock rollback; this is not a real PG/broker adapter.

No existing production entrypoint, database migration, runtime import, dependency, security setting or permission is changed. No parser package is imported by these schema modules.

## Verification

Run from the repository root:

```sh
node --experimental-strip-types --test apps/web/test/sandbox/document-contract.test.mjs apps/web/test/sandbox/xlsx-close.test.mjs apps/web/test/sandbox/pdf-rotation-schema.test.mjs apps/web/test/sandbox/document-execution-boundary.test.mjs
```

Final local stage: 64 tests passed, no failures or skips. New implementation was preceded by missing-implementation tests; the control review regressions failed 6 cases before correction, outline failed 3 cases before implementation, and the pending gate failed 1 before implementation. Logs were retained in the working environment, not mistaken for checked-in production evidence.

The eight new TypeScript modules also passed an isolated strict check using the available TypeScript compiler with `--noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions`. This is not the full worker/application typecheck. An independently reviewed source snapshot and direct test rerun cover the contract stage; full repository regression was not run against a complete current checkout.

## Remaining scope

The broad Task 1 inventory and all four formats' complete request/reply schemas are not closed. This stage supplies bounded schema-only examples rather than admitting unvalidated commands. XLSX open remains refused because the real WorkbookMetadata reply contains nested styles/visuals/names/theme/protection data not yet fully validated; no simplified metadata projection is claimed as that schema. Runtime broker/IPC, immutable manifests, durable reservations/reconciliation, command adapters, real PostgreSQL/T06 integration, browser-origin isolation, openEuler dual-architecture/SELinux tests and desktop fidelity are later work.

The entrypoint inventory identifies reachable non-production upload worker-thread validation and legacy DOCX API parsing. Existing production guards must remain; schema helpers do not remediate those runtime boundaries. See the inventory's source registration chains and required disposition before enabling any production path.
