# T15 query snapshot foundation (not integration acceptance)

This increment implements only the pure QuerySnapshot evidence contract from T15. It registers no API route, performs no network/database I/O, reads no credential and changes no authorization scope. Existing unimplemented source routes remain denied in the account application.

The builder preserves column order, primitive cell values, units and timezone. SHA-256 covers normalized source ID/version, schema, timezone, rows and truncation. Row order is significant; object property order is not. Limits are at most 10,000 retained rows, 256 columns and 8,000,000 UTF-8 bytes including the hash field. Upstream/row-limit truncation is explicit. Oversized bytes, non-finite numbers, negative zero and mismatched cells fail closed instead of silently normalizing values. Only retained rows are validated; callers must already bound connector response parsing. This hash is integrity evidence, not an authorization capability or cryptographic attestation of a source.

Local evidence (Node 24.22.1):
- Initial stub produced failing behavioral assertions.
- Six focused tests pass: metadata/value retention, deterministic hash, row/upstream truncation, malformed evidence, limits/error safety, detached freezing, UTF-8 exact-byte boundary.
- Strict standalone TypeScript compilation of both new modules passes.
- Independent review identified missing hash-envelope byte accounting; the added regression failed first, then passed after the fix; re-review found no further explicit blocker.

Still pending: T12 versioned source configuration and server-only credential resolution; independent source grants (not file ownership or config-admin bypass); authenticated source query service; SSRF-safe HTTP transport; real read-only database connector/privileges; actual source mapping and provenance integration. No real database, HTTP source, browser or production acceptance was performed. T15 remains open. Actions are unchanged and no CI pass is claimed.
