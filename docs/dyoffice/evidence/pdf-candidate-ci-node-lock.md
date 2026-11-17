# PDF candidate build runtime alignment

Base #134 `79187ad1a13e2f58f1861727b7788f9c69d73232`.
Boundary job `133993756736` failed 13 PDF integration setup hooks because the
builder recorded the actual CI Node 22.23.5, while its validator required Node 24
and its recipe targeted node24. This was not a PostgreSQL authorization failure.

The nonlaunchable PDF fixture candidate adds exactly Node v22.23.5, aligned
with `tools/dyoffice/runtime-lock.json`, while retaining its original local v24.x.y
range. Other Node22 versions and other majors remain rejected. Both supported
build runtimes consistently build/verify a fixed node22 recipe. Unsupported build
versions fail before compilation. Old node24-recipe candidates must be rebuilt
(on either supported runtime); they are not silently reinterpreted or approved.
The runtime lock describes CI, not production deployment approval.

All byte hashes, external expected digest, path/symlink/hardlink restrictions,
fixed recipe matching and false `identityCertified`, `runtimeApproved`,
`productionEnabled`, and `rootfsComplete` flags remain. No execution grant or
production runtime registration is added. Wrong patch/major and wrong recipe
values are rejected by tests.

Real local evidence:
- Downloaded the official Node v22.23.5 archive using the locked URL. Archive
  SHA-256 cdeb8670a0c81f51b4dc4ac61919f9b1ad917b304bf8221eb939570663d240f8;
  binary SHA-256 2f822d544601dfff107f57d945b649d15c5bf6302595735a6bd9cdc7ee9669bd.
  Both match the repository lock. System Node was not replaced.
- Under that real binary, RED reproduced the same validator location/error.
- Fixed artifact/runtime-lock/wire tests: 5/5 on real locked Node22.23.5 and
  5/5 on the existing Node24.22.1. Actual generated PDF bytes,
  reproducible digest, binding and fault/timeout behavior verified.
- Real PG17 PDF artifact-context and prepared-package integration: 13/13, no
  skips, exact Node22 binary. Independent cluster stopped after tests.
- Local shared dependency hardlinks initially failed the existing build fence;
  test dependencies were copied into independent ordinary files. The fence was
  not weakened or disabled.

No browser or external AI harness was invoked. PPTX's separate candidate builder
retains its existing toolchain contract and was not changed by this PDF slice.
