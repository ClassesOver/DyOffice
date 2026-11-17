# Native XLSX save latency — 2026-11-17

## Status and scope

This is a bounded native XLSX save improvement on base `415c38f5314c4c08333720fd1944ed4ebdf2b543`. The overall P0 performance goal is **not complete**. This does not establish production p95, capacity, large-workbook performance, or StarRocks results.

Only the authorized `p0-native-save-latency` worktree was changed. The independently built native artifacts in `p0-hardening` were read only. Recomputed source fingerprint `9a7a316022020ea827709d1a35a8f17349d9183962dd3f1ab7139c95d5ca7fac` matches its manifest; native SHA-256 is `813dbc12950ed102194ebbe26d65ce049b791172c509596778944c6479bb6a2d`, probe SHA-256 is `396ea805b26ea9d7166f91a05029de2e684ec2b2a9637a95070ca594aa4d1d3d`. Rust source/binaries were not modified.

## Change and safety boundary

- The existing systemd-isolated Node gateway has an opt-in `planFromWorkbook(bytes, request)` method. It opens one existing bounded `EntrySource`, derives sheet identities using the existing workbook sheet parser, and passes that exact source into the existing desktop mutation planner. The API process does not import or execute the workbook parser.
- Native identities remain `sheet-${sheetId}`, matching Rust `format!("sheet-{}", declaration.sheet_id)`. Names use the shared entity decoder; existing namespace normalization remains in use. Duplicate/missing identities, missing/external worksheet relationships, unsafe relationship targets, and ambiguous XML declarations are rejected. The opt-in intentionally fails closed for workbook sheet declarations outside the existing text parser's supported double-quoted empty-element grammar, comments/CDATA/DTD/processing instructions, and ambiguous attribute syntax; this is a compatibility limitation, not a claim of support for every legal OOXML spelling. It never silently falls back to a different mapping.
- Experimental runtime selects this isolated method for save preparation. Legacy callers retain inspect + explicit mapping, with only `{id,name}` projected into the strict gateway wire contract. The browser cannot supply a mapping for the optimized method.
- Only the redundant source Rust inspect is removed. Rust `savePlan` still validates archive inventory, unchanged-entry CRC/size, and opens the output workbook before returning bytes. Bridge post-commit inspect is retained. No saved metadata is reused for an acknowledgement.
- Initial lease/owner/head checks, authorized revision byte download, staging checks after native work, upload reception, final lease renewal, and atomic T06 commit checks are unchanged. No principal/authority cache, skiphash, hardlink publication, mtime cache, pool expansion, or integrity bypass was introduced.

### Existing strict-wire failure discovered before optimization

An unmodified full isolated save failed with HTTP 400: `native.inspect` returns sheet objects containing additional metadata, but `gateway-process` accepts exact `{id,name}` objects. Existing save-service tests used the in-process planner and did not expose this. The first failed run did not commit and is not counted as a latency success.

The successful baseline uses an explicit id/name projection in the benchmark's legacy planner wrapper. Both baseline and after use that same wrapper for the legacy option. The adapter now performs this projection too, covered by a RED→GREEN regression. Thus the measured baseline is the original three-process successful chain with this necessary contract correction, not a claim that untouched HEAD completed it successfully.

## Measurement method

Reproducible harness: `apps/web/test/performance/p0-native-save-benchmark.test.mjs`.

Each round imports the same fixture as a new file, acquires a real lease, then measures authenticated HTTP-inject prepare + T06 commit + the bridge's subsequent inspect. The Rust native process and bundled Node gateway really run under the existing root systemd sandbox. PostgreSQL is disposable loopback port 55433; S3 is disposable loopback port 19000 with a new fixture bucket. No Docker, customer database, mocked delays, or mocked native output is used. The configured existing askpass helper authorized root execution; no password file was read or credential collected.

Fixture: `apps/web/test/fixtures/sheets/acceptance.xlsx`, 3,961 bytes, SHA-256 `6834536e6ba5f41215157d12220377f62e218d234552edc2a243feb05f6493fb`. Root Node: v24.22.3. Native binary source/hash verification above. Each process call remains cold, including full per-call executable hashing/snapshot isolation. Import, lease acquisition, initial metadata lookup, build, and post-measurement digest/history checks are outside the timed window, identically on both paths. The bridge metric measures its existing inspect endpoint, not browser rendering or network transport. Each committed output digest/size is compared with prepare, readback SHA is verified, and original revision bytes remain identical.

All SQL client statements issued by measured auth/business pools are counted, including transaction setup, authority checks, and one-time runtime role/schema admission. First rounds include 317 additional runtime admission statements and are **not dropped**. Counts for every run are `[508,191,191]`; prepare counts `[441,124,124]`. Per-round totals are auth 30 + business 478 on round 0; auth 30 + business 161 thereafter. No SQL reduction is claimed.

The harness requires `DYOFFICE_RUN_NATIVE_SAVE_BENCHMARK=synthetic-local-only`, the designated disposable test variables, and the verified `DYOFFICE_TEST_HOST_MANIFEST`. Set `DYOFFICE_NATIVE_SAVE_PLANNER=legacy` or `workbook`; optional `DYOFFICE_P0_LABEL` labels the JSON diagnostic. Run from the authorized worktree with the existing root helper and `node --import tsx --test --test-concurrency=1 apps/web/test/performance/p0-native-save-benchmark.test.mjs`. Test credentials are not reproduced here. The strip-only runner failed before execution because an existing unrelated source module uses TypeScript parameter properties; `tsx` is the repository-supported loader used for all successful runs.

## Results: all runs, including the slow after group

| Group | Median prepare ms | Median commit ms | Median prepare+commit ms | Median bridge inspect ms | Median including bridge ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Initial corrected legacy baseline | 2502.359900 | 52.094347 | 2554.484157 | 344.037585 | 2895.645376 |
| Initial workbook planner | 2546.308575 | 53.377667 | 2598.304737 | 366.593501 | 2964.933394 |
| Adjacent repeat legacy | 2525.596428 | 50.738951 | 2576.366383 | 347.281034 | 2923.675565 |
| Adjacent repeat workbook | 2196.882927 | 51.563546 | 2248.479515 | 348.824572 | 2595.849943 |
| Final workbook XML guards | 2238.091612 | 54.152805 | 2282.558571 | 361.586237 | 2644.178792 |

- Stable process count: prepare **3 → 2** launches (33.33% fewer); including bridge inspect **4 → 3** (25% fewer). Rust prepare launches 2 → 1; one Node gateway remains. The benchmark asserts those exact counts. This is a verified service-chain reduction, independent of latency noise.
- Initial after group was **1.72% slower** for prepare+commit and **2.39% slower** including bridge. Gateway times `[2897.20,1659.72,1354.33]` ms versus initial legacy `[1349.71,1278.95,1302.81]` ms show substantial host/run variability. No sample is discarded.
- The immediately adjacent repeat measured prepare+commit median **2576.37 → 2248.48 ms**, **12.73% lower**; including bridge **2923.68 → 2595.85 ms**, **11.21% lower**. These are local observations from three samples per group, not a production p95 or an overall P0 pass.
- Final XML ambiguity guards were then validated by another three complete real saves; median prepare+commit 2282.56 ms. Earlier groups are retained and not substituted with this later run.

### Raw JSON samples

`coldStartCount` below includes bridge inspect. Legacy commands per sample are `rust:open, rust:close, gateway:gateway_plan, rust:save_archive, rust:open, rust:close, rust:open, rust:close`. Workbook commands are `gateway:gateway_plan, rust:save_archive, rust:open, rust:close, rust:open, rust:close`. `nativeMs` is cumulative process time by kind including preparation/cleanup; concurrent capacity is not measured. SQL scope is defined above.

```json
{
  "initialLegacy": [
    {"round":0,"prepareMs":2977.131817,"commitMs":77.304173,"prepareCommitMs":3054.537102,"bridgeInspectMs":365.071494,"withBridgeInspectMs":3419.653718,"coldStartCount":4,"coldStarts":{"rust":3,"gateway":1},"nativeMs":{"rust":1082.779257,"gateway":1349.708535},"sqlCount":508,"prepareSql":441,"sqlCounts":{"auth":30,"business":478,"owner":0}},
    {"round":1,"prepareMs":2502.359900,"commitMs":52.094347,"prepareCommitMs":2554.484157,"bridgeInspectMs":340.584459,"withBridgeInspectMs":2895.101538,"coldStartCount":4,"coldStarts":{"rust":3,"gateway":1},"nativeMs":{"rust":995.025821,"gateway":1278.946587},"sqlCount":191,"prepareSql":124,"sqlCounts":{"auth":30,"business":161,"owner":0}},
    {"round":2,"prepareMs":2501.421755,"commitMs":50.121480,"prepareCommitMs":2551.579498,"bridgeInspectMs":344.037585,"withBridgeInspectMs":2895.645376,"coldStartCount":4,"coldStarts":{"rust":3,"gateway":1},"nativeMs":{"rust":994.160251,"gateway":1302.809742},"sqlCount":191,"prepareSql":124,"sqlCounts":{"auth":30,"business":161,"owner":0}}
  ],
  "initialWorkbook": [
    {"round":0,"prepareMs":4181.080644,"commitMs":61.932672,"prepareCommitMs":4243.131466,"bridgeInspectMs":338.425765,"withBridgeInspectMs":4581.604735,"coldStartCount":3,"coldStarts":{"rust":2,"gateway":1},"nativeMs":{"rust":648.203017,"gateway":2897.197955},"sqlCount":508,"prepareSql":441,"sqlCounts":{"auth":30,"business":478,"owner":0}},
    {"round":1,"prepareMs":2546.308575,"commitMs":51.963788,"prepareCommitMs":2598.304737,"bridgeInspectMs":366.593501,"withBridgeInspectMs":2964.933394,"coldStartCount":3,"coldStarts":{"rust":2,"gateway":1},"nativeMs":{"rust":679.819712,"gateway":1659.716749},"sqlCount":191,"prepareSql":124,"sqlCounts":{"auth":30,"business":161,"owner":0}},
    {"round":2,"prepareMs":2185.656047,"commitMs":53.377667,"prepareCommitMs":2239.063671,"bridgeInspectMs":382.247726,"withBridgeInspectMs":2621.341716,"coldStartCount":3,"coldStarts":{"rust":2,"gateway":1},"nativeMs":{"rust":661.957674,"gateway":1354.330396},"sqlCount":191,"prepareSql":124,"sqlCounts":{"auth":30,"business":161,"owner":0}}
  ],
  "repeatLegacy": [
    {"round":0,"prepareMs":2953.993473,"commitMs":75.598328,"prepareCommitMs":3029.693991,"bridgeInspectMs":356.302091,"withBridgeInspectMs":3386.037615,"coldStartCount":4,"coldStarts":{"rust":3,"gateway":1},"nativeMs":{"rust":1006.854655,"gateway":1390.874104},"sqlCount":508,"prepareSql":441,"sqlCounts":{"auth":30,"business":478,"owner":0}},
    {"round":1,"prepareMs":2504.067183,"commitMs":46.329119,"prepareCommitMs":2550.428595,"bridgeInspectMs":345.372659,"withBridgeInspectMs":2895.843832,"coldStartCount":4,"coldStarts":{"rust":3,"gateway":1},"nativeMs":{"rust":989.232880,"gateway":1311.621997},"sqlCount":191,"prepareSql":124,"sqlCounts":{"auth":30,"business":161,"owner":0}},
    {"round":2,"prepareMs":2525.596428,"commitMs":50.738951,"prepareCommitMs":2576.366383,"bridgeInspectMs":347.281034,"withBridgeInspectMs":2923.675565,"coldStartCount":4,"coldStarts":{"rust":3,"gateway":1},"nativeMs":{"rust":987.800824,"gateway":1344.342518},"sqlCount":191,"prepareSql":124,"sqlCounts":{"auth":30,"business":161,"owner":0}}
  ],
  "repeatWorkbook": [
    {"round":0,"prepareMs":2582.934198,"commitMs":72.519540,"prepareCommitMs":2655.560565,"bridgeInspectMs":360.723365,"withBridgeInspectMs":3016.344421,"coldStartCount":3,"coldStarts":{"rust":2,"gateway":1},"nativeMs":{"rust":674.336755,"gateway":1357.293028},"sqlCount":508,"prepareSql":441,"sqlCounts":{"auth":30,"business":478,"owner":0}},
    {"round":1,"prepareMs":2196.882927,"commitMs":51.563546,"prepareCommitMs":2248.479515,"bridgeInspectMs":347.322476,"withBridgeInspectMs":2595.849943,"coldStartCount":3,"coldStarts":{"rust":2,"gateway":1},"nativeMs":{"rust":689.312976,"gateway":1296.212710},"sqlCount":191,"prepareSql":124,"sqlCounts":{"auth":30,"business":161,"owner":0}},
    {"round":2,"prepareMs":2151.172939,"commitMs":50.374204,"prepareCommitMs":2201.578250,"bridgeInspectMs":348.824572,"withBridgeInspectMs":2550.430997,"coldStartCount":3,"coldStarts":{"rust":2,"gateway":1},"nativeMs":{"rust":632.800088,"gateway":1311.209614},"sqlCount":191,"prepareSql":124,"sqlCounts":{"auth":30,"business":161,"owner":0}}
  ],
  "finalWorkbookGuards": [
    {"round":0,"prepareMs":2529.122724,"commitMs":69.870501,"prepareCommitMs":2599.088421,"bridgeInspectMs":344.570266,"withBridgeInspectMs":2943.720852,"coldStartCount":3,"coldStarts":{"rust":2,"gateway":1},"nativeMs":{"rust":621.377115,"gateway":1352.537647},"sqlCount":508,"prepareSql":441,"sqlCounts":{"auth":30,"business":478,"owner":0}},
    {"round":1,"prepareMs":2238.091612,"commitMs":44.436560,"prepareCommitMs":2282.558571,"bridgeInspectMs":361.586237,"withBridgeInspectMs":2644.178792,"coldStartCount":3,"coldStarts":{"rust":2,"gateway":1},"nativeMs":{"rust":707.228838,"gateway":1342.174990},"sqlCount":191,"prepareSql":124,"sqlCounts":{"auth":30,"business":161,"owner":0}},
    {"round":2,"prepareMs":2145.513627,"commitMs":54.152805,"prepareCommitMs":2199.697743,"bridgeInspectMs":390.608751,"withBridgeInspectMs":2590.336796,"coldStartCount":3,"coldStarts":{"rust":2,"gateway":1},"nativeMs":{"rust":685.664085,"gateway":1289.220441},"sqlCount":191,"prepareSql":124,"sqlCounts":{"auth":30,"business":161,"owner":0}}
  ]
}
```

## Verification

- RED: 15 targeted tests, 10 passed / 5 failed before implementation. Failures exposed redundant inspect/legacy call path, missing opt-in method, cancellation not entering that method, and unprojected native metadata.
- GREEN: the same 15/15 passed. Stable call-order assertions retain initial lease/head/read and stage/receive/final lease, with no inspect fallback. The real benchmark separately asserts actual launch counts.
- Real isolated Node gateway tests: 4/4 passed, including id/name contract, cell + structural rename, native-save/reopen preserving `sheet-1`, planning the next mutation from saved bytes, forged ID rejection, cancellation cleanup, dynamic UID/private root/no controller secret/capability stripping.
- Real PostgreSQL save-service tests: 6/6 passed, including owner/B/Admin isolation and lease takeover, head advance, session revocation, and tombstone while work is blocked. None publishes a stale draft. Native roundtrip preserves the original revision and untouched custom XML; T06 receipt replay is idempotent.
- Workbook gateway schema/metadata test passed, covering decoded names, duplicate/missing/forged identities, malformed/unsupported attributes, comment-shaped declarations, missing relationships, and unsupported browser paths.
- Target suite comprises `native-sheets/{save-service,save-workbook-plan,gateway,gateway-cancellation,lease-barriers,save-plan}`, `host-native/gateway`, `unit/gateway-adapter`, `local-integration/{ownership-rls,revision-commit}`, and `write-leases` (80 tests). An initial invocation passed 79 and failed the S3-specific T06 test solely because that command omitted the disposable S3 environment. That test and the final four real gateway tests were then rerun with it and passed 5/5. Final full configured repeat: **80 passed, 0 failed, 0 skipped**, duration 147,617.25 ms.
- Server and worker TypeScript checks passed: `node node_modules/typescript/bin/tsc -p apps/web/server/tsconfig.json --noEmit` and the analogous worker command. `git diff --check` passed.
- Five benchmark groups / fifteen real complete prepare+commit+inspect rounds passed; all raw samples above are retained, rounded to six decimal milliseconds for readability.

## Still open / not claimed

- Overall original P0 save latency, production p95/capacity, concurrent editors, long-session performance, and large representative workbook coverage remain unproven.
- The bridge's extra inspect launch, other native endpoint cold launches, and remaining gateway cold startup are not optimized here.
- No production deployment, browser rendering/e2e suite, complete native runtime/server entry suite, full worker/jobs suite, or whole-repository test run was performed for this patch. Native source was unchanged and not rebuilt.
- No StarRocks/customer credentials or customer data were used; customer validation is separate work. Other P0 targets and concurrent integration/provider work are outside this change.
