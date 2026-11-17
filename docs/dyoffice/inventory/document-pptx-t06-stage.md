# PPTX actual editing and T06 persistence test slice

## Scope

This slice exercises the existing `createPptxSession`, `createSlidesService`,
`createSlidesSaveService.prepare`, and T06 services with real PostgreSQL and
RustFS. It generates a trusted one-slide PPTX using `pptxgenjs`, changes its text
through the actual PPTX operation engine, exports, commits, downloads and reopens
with the actual parser/render model. No synthetic processor output is substituted.

The **test-only** host calls the engine in the test process. This is neither an
isolated child nor an ordinary-fork fallback. No HTTP route, production host,
manager, enabled format, or security setting is changed. Untrusted documents are
not inputs to these tests. Systemd/SELinux/cgroup and desktop PowerPoint visual
acceptance remain unverified; this does not certify four-format support.

## Source and dependencies

Baseline: `40e0bff447a513f4130cf0891429484c24cde4b2`.

| Actual implementation | Git blob |
|---|---|
| `apps/web/worker/src/native/pptx-session.ts` | `d7b2cdcc488f5718b5344946ef9315e9bef1e10f` |
| `apps/web/server/src/modules/slides/service.ts` | `bbd02cafd039d468a95ddaa7b06618fd6d8eb598` |
| `apps/web/server/src/modules/slides/save.ts` | `0a972dc67bb0bb74317d88e8aa1759a3f6c45809` |

Those three baseline files were materialized unchanged for this partial local
checkout, not proposed as new production modifications. Esbuild bundles the real
session for tests, including its build-time `.md?raw` operation documentation;
no handler is stubbed. Its metafile identifies 96 loaded workspace source files,
all checked against this baseline's Git blob hashes. The loaded DOCX dependency
is only `math.ts` and `xml-utils.ts`; it does not load the unrelated local
`docx-engine/src/patch.ts` snapshot. Dependencies use the existing installation;
no shared lockfile or node_modules package was modified.

## Tests

`apps/web/test/local-integration/pptx-save-s3.test.mjs` covers:

1. Actual text edit, export, stage/receive/commit, exact receipt replay, immutable
   stored-byte reopen and live draft adoption from its own proven committed upload.
2. Stale generation rejects preparation without changing database state.
3. Lease takeover blocks prepared commit and dirty-session inheritance; a fresh
   authorized open sees only the original persisted deck.
4. The actual commit succeeds, then a client-wrapper exception simulates loss of
   confirmation. Replaying the original input recovers one receipt, without export.
5. A test-schema receipt trigger fails the actual transaction. Metadata rolls back;
   removing that trigger permits the same prepared object/input to commit.
6. Session revocation rejects an already prepared commit.

The fault in (4) is client-confirmation-loss injection, not a real network outage
or killed process. PostgreSQL uses the existing restricted-role fixture; RustFS
uses unique test buckets and loopback-only endpoints. Tests use `buildApp:false`,
which does not weaken authority or RLS and does not construct the HTTP application.

Run with the repository's PostgreSQL and S3 test environment variables configured:

```sh
node --experimental-strip-types --test --test-concurrency=1 \
  apps/web/test/local-integration/pptx-save-s3.test.mjs
```

The test bundles the actual engine with existing `esbuild` and creates/removes a
temporary CJS artifact. This command is not a production broker startup command.
Full HTTP/desktop/browser coverage is outside this slice.

## Verification result

The six tests above passed against real PostgreSQL 17 and RustFS 1.0.6
(6 passed, 0 failed, 0 skipped). The services were stopped after the run.
These are regression tests of existing implementation, not a claim that a
new production defect was repaired. The full application/HTTP suite was not run
in this partial checkout; no production isolation acceptance is implied.

Runner interoperability: combined tests use `node --import tsx`. The original
ESM default import of pptxgenjs was not a constructor under that loader. The test
now selects pptxgenjs's documented CommonJS export with Node `createRequire`;
no library or engine code changed. The import failure was reproduced before the
fix, then all six PG/RustFS cases passed under both `--import tsx` and native
`--experimental-strip-types`. This was a test-runner integration defect, not a
PPTX editing defect.
