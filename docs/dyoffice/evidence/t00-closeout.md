# T00 closure review: source gates complete, runtime pinning still open

Reviewed target: `26ee881ea626f5704fc2e532fd65b852117d68f6` (tree
`25ecfc0105ceceba43377744a8e2a7112ebab606`), plus this PR's inventory/CI/documentation changes.
Date: 2026-11-16. The candidate preserves T01 #31 and does not include the unmerged #21 new identity/worker stack.

## Original T00 requirements, not later feature acceptance

| Original requirement | Verified evidence | Status / remaining scope |
| --- | --- | --- |
| Reject browser Node/Electron imports with reproducible regressions | `tools/check-web-boundaries.test.mjs`; current graph 129 files, zero violations | Passed source gate. Computed imports, third-party runtime/bundle behavior remain outside this static checker. |
| Mark every planned reused tool live/headless/unsupported | New [151-definition registry](../inventory/agent-tools.md), exact reviewed [classifications](../inventory/agent-tools.json), AST discovery and drift gate | Passed **declaration inventory**. These are proposed placements, never runtime availability, authorization, or successful tool execution. Dynamic tool registration is outside the scanner's documented scope. |
| Inventory renderer/preload/main, Rust/fonts/MCP locks | [Host IPC table](../inventory/host-ipc.md): 538 members with source, callers, channels, lifecycle and proposed Web seam; [compatibility lock](../inventory/compatibility-lock.json): 84 inputs including 66 font assets | Passed source inventory. Argument/return contracts and precise per-method error behavior are not all extracted; the adapter task must verify its actual implementation/capability status. |
| Existing Web tests plus minimal build GREEN | Local API 198 passed / 0 failed / 1 skipped; typecheck passed; build/HTTP asset smoke 2 passed; 84 compatibility inputs with no drift | Passed bounded local gates. S3 lifecycle was skipped because `DYOFFICE_S3_ENDPOINT` is absent, not counted as a pass. |
| Reviewed commit/CI establishing gates | Existing target's Web gate and shell UI runs below; this PR adds a fail-closed tool-inventory gate | Target evidence passed; the candidate must obtain its own CI before merge. |
| Locked dependency/image manifest | npm versions/integrity, Cargo lock packages and bundled font bytes are recorded. CI runtime declarations are enumerated below | **Partial**: mutable runtime tags are not image/toolchain pins. No production deployment image exists at this target, so there is no production digest to invent. |

T00 is **not marked fully complete** while the runtime-pinning row remains partial.
This PR closes a concrete tool-inventory gap rather than relabeling incomplete work as done.
Four-editor UI equivalence, native writes/recalculation, external Office reopening, real models/MCP clients,
RLS and recovery belong to their later tasks; their evidence cannot be manufactured by checking a T00 box.

## Exact-commit CI observed

All three runs below completed successfully for `26ee881ea626f5704fc2e532fd65b852117d68f6`:

- [Web boundary, compatibility, typecheck, build and legacy API gate](https://github.com/ClassesOver/DyOffice/actions/runs/43801598762)
- [Original shell UI gate](https://github.com/ClassesOver/DyOffice/actions/runs/43801598663)
- [Native PPTX gate](https://github.com/ClassesOver/DyOffice/actions/runs/43801598679)

These are not results for the new candidate and not evidence that every other workflow ran on this commit.
Historical `t00-engineering-gates.md` is retained as a dated checkpoint; its 38/58 Sheets scanner numbers are not current.

## Runtime/image inventory and precise pinning boundary

| Input | Current declaration | Immutable? | Next evidence needed |
| --- | --- | --- | --- |
| npm source dependencies | Root/Web/worker locks; selected exact versions and integrity in compatibility-lock.json | Package locks, yes; not a runtime image | Reproduce each installation context without silently mixing separate lockfiles. |
| Rust native dependencies | XLSX and Windows helper Cargo.lock, edition/build configuration | Dependency lock, yes; toolchain/ABI, no | Pin compiler, target, native artifact hash and isolated execution profile after #21 is integrated and validated. |
| GitHub checkout/setup-node actions | `3d3c42e5aac5ba805825da76410c181273ba90b1` / `820762786026740c76f36085b0efc47a31fe5020` | Action source commits, yes | An action pin does not pin the OS or Node binary it selects. |
| CI runner | `ubuntu-latest` in all DyOffice workflows | **No** | Record/freeze selected runner OS/toolchain or approved immutable builder for release reproduction. |
| CI Node | `node-version: 22`; root engines `>=22.12.0` | **No exact patch/binary pin** | Choose and validate a supported exact runtime for the release; this PR does not silently change support policy. |
| Identity CI PostgreSQL | `postgres:16` in identity/login/account/password/session workflows | **No image digest pin** | Resolve a trusted digest, test it, then update the relevant CI/deployment configuration together. |
| S3 CI MinIO | `bitnamilegacy/minio:2025.7.23-debian-12-r5` | Versioned tag, **not digest-pinned** | Record verified image digest and rerun real S3 lifecycle checks. |
| Production API/worker images | No production image manifest selected in this target | Not applicable **as an existing artifact**, not waived for delivery | T23 must choose/pin its deliverables. Do not invent a production digest or declare production readiness. |

No image tag above is presented as an immutable digest. Native ABI, browser font metrics, license review of the
packaged deliverable and production SBOM remain separate from hashing source inputs.

## Local reproduction and limits

Commands executed against the complete target snapshot plus this candidate:

```sh
node --test tools/check-web-boundaries.test.mjs tools/audit-web-host.test.mjs tools/dyoffice/*.test.mjs
node tools/audit-web-host.mjs --summary
node tools/dyoffice/agent-tool-inventory.mjs --check
node tools/dyoffice/compatibility-baseline.mjs --check
node tools/check-web-boundaries.mjs
npm run test:web
npm run typecheck:web
npm run test:web:build
git diff --check
```

Local gate regressions: 43 passed, 0 failed, 0 skipped. IPC scan: 117 Docs / 114 Sheets / 221 Slides / 86 PDF members, zero unmatched or opaque calls. Tool inventory: 151 definitions with explicit placement.

Local Node 24.22.1. Existing external npm packages were reused to fit the executor's storage limits;
all workspace links were redirected to this exact candidate's sources. This is **not a fresh-install proof**.
The target CI above ran its own declared install; the candidate's CI must independently do the same.
No production credentials, real business documents or customer data were used.
