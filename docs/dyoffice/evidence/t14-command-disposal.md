# T14 command transport disposal

Independent local slice on #87 e662ff0. Disjoint from #88: changes only
http-commands.ts, its tests and this evidence. No merge or production mount.

Root cause: CSRF and fetch waits did not settle when disposed. The response reader
cancelled on abort, but its finally block awaited the underlying cancel promise,
which can remain pending forever. Three regressions first failed with pending
instead of stopped.

The minimal correction races waiting against disposal, observes late rejection,
fences late token dispatch, and cancels late responses including the response-arrival
microtask window. Cleanup does not wait indefinitely. No execution claim is delivered
after disposal and no retry is added. This is local cancellation, not server rollback.
An uncooperative underlying callback cannot be forcibly terminated by this API.

Verification:
- Command client 13/13 including 5 added tests; independent reviewer repeated all13.
- Web unit329/329, zero skips.
- Strict focused TypeScript passed.
- Full npm test attempted: exit137/Killed at @genoffice/docx-engine after earlier
  i18n/electron-utils/font-metrics/zip-gate stages. Not a full monorepo pass.
- Ordinary Web serial test result recorded separately in web.log.
- Patch apply check against original #87 snapshot passed.

No new request deadline, real PostgreSQL or browser acceptance, general Word support
or T14 full closure is claimed. No existing regression assertion was weakened.

Final ordinary Web serial regression: 271 passed, 0 failed, 1 optional S3 skip
(endpoint unset), 48.93s. This does not replace real database/browser acceptance.
