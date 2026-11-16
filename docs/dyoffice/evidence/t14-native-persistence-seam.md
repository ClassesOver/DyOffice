# T14 real native-to-T06 persistence seam

Base f42f9113. Test-only integration of existing production components: native editorExtensions and approved-text primitive, blocksToPmDoc/pmDocToSavePlan, saveDocx, authenticated command HTTP client/executor, command-save coordinator/SessionFileHost, actual PostgreSQL transactions and actual loopback RustFS objects. No controlled-template profile, shadow model, production mount, new permission or migration is introduced.

## Run

With disposable loopback PostgreSQL and S3 fixture variables set:

```
NODE_OPTIONS=--max-old-space-size=768 node node_modules/vitest/vitest.mjs run --config apps/web/vitest.native-command.config.mjs
```

Both services are mandatory; missing S3 is a hard failure, not a skip. This explicit config is separate from ordinary Web/node tests and ordinary Docs Vitest tests. It inherits checkout-local source aliases. Node environment retains server file URL/fetch/crypto semantics; a setup installs only DOM facilities needed for actual native editor code.

## Fresh verification

Real PG17 + RustFS6/6 passed, zero skips, exit0 (16.3s total,9.0s test time). Cases: normal commit, actual committed response loss then exact-tuple reconciliation, lease takeover rejecting execution, new edit during serialization, new edit during staging, and newer native edit while old snapshot commit returns.

All cases require explicit approval and prevent execution replay. Success reads exact serializer bytes from RustFS, parses actual DOCX, reconstructs an actual native Editor and verifies changed text. Untouched second paragraph, header, styles and custom part are checked. Committed journal revision matches the returned revision; database receipt and upload binding counts are each1. Lost-response reconciliation may make2commit HTTP requests but leaves1durable receipt. Newer native text/generation survives an old snapshot commit; this does NOT assert the full App dirty flag is correctly wired.

Independent review required cleanup to continue after errors. All cleanup hooks now run, accumulating cleanup and original case errors into AggregateError. No test failure can silently become a pass.

## Failed runs preserved

Initial jsdom runner rewrote server import.meta URL to http://localhost and failed before tests. Node environment plus explicit DOM setup fixed infrastructure without mocking production logic. Second run6/6failed because extensionless lease service import resolved legacy service.mjs; explicit current .ts imports fixed it. Types found fixture nullable user, widened descriptor and Buffer DOM-body incompatibility; narrowed real fixture user, declared ToolDescriptor and copied response bytes into ArrayBuffer. Assertions and runtime production contracts were not weakened.

## Limits

This uses real services and native editor code under a Node/DOM harness with Fastify injection, not actual browser HTTP sockets or desktop GUI. The generated bounded plain-text DOCX fixture is not arbitrary document coverage. Existing many-metadata-input buildDocBytes/App save composition is not mounted here: saveDocx uses the native PM save plan for this fixture. The shared fence is not claimed to cover the whole App. No production write enablement, provider integration, automatic retry or full T14 closure. Browser/desktop acceptance deferred by owner, not passed.

Final focused strict TypeScript including integration test passed, exit0; boundary999/0. Independent reviewer repeated actual PostgreSQL/RustFS6/6, zero skips, exit0 (15.11s), confirmed cleanup and runner fixes, and verified services stopped. Independent log retained. This is independent repetition of the persistence seam, not browser/desktop acceptance.
