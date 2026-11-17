# P0 hot-path follow-up and safety review — 2026-11-17

## Acceptance status

The original P0 performance goal is NOT complete. The initial patch 8c89e197 passed a limited regression set but introduced integrity and authority regressions. Those changes must not be accepted based on the original performance description. Safety corrections are retained separately from the later small, measured authentication optimization.

## Corrected defects

- Size/mtime-based trusted-binary caching and hard-link publication were removed. Every execution reads a bounded O_NOFOLLOW FD, verifies its SHA-256 and writes a separate snapshot inode. Host mutation cannot change an already-running snapshot or bypass future verification by restoring timestamps. Library copies use independent inodes and may request copy-on-write cloning; systemd/cgroup/namespace isolation remains unchanged.
- Revision commits bind preflight object verification to the final locked key, size and digest. No optimistic-row absence/change permits an unverified new reference. Tombstones are checked under the account lock before returning an old receipt. Concurrent exact-key receipts and job restrictions remain intact.
- Verification is before account/file write locks, but the enclosing principal transaction still holds authority locks. It is incorrect to claim all locks or the full transaction were removed from object I/O.
- Per-request session activity updates were restored; 30-second write throttling would shorten the effective idle lifetime and was not semantics-preserving.
- Supplied object digests/sizes cannot skip validation or enlarge the byte budget. The identity pool is restored to the original limit of four; no performance claim is made from pool expansion.

## Measured, safe optimization

Role lookup and the authority clock are now read together at the same locked-request boundary. All lock order, per-request authorization, idle updates and final expiry checks are retained. No cross-request principal cache is introduced.

Sequential loopback PostgreSQL benchmark: 20 warmup + 100 measured authenticate calls, unchanged pools. Counted queries exclude fixed transaction statements equally on both sides.

| Run | Median | p95 | Counted queries |
| --- | ---: | ---: | ---: |
| Safe baseline | 7.4706 ms | 8.7616 ms | 7 |
| Same-request query merge | 7.3056 ms | 8.2082 ms | 6 |
| Integrated repeat | 7.6744 ms | 8.9894 ms | 6 |

This confirms one fewer query, not a production latency/capacity guarantee. The integrated repeat illustrates host-load variability.

A separate 8 MiB loopback PostgreSQL/RustFS commit benchmark measured 165.83→170.55 ms median; it showed no end-to-end speedup. The after run overlapped a Rust build. Callback SQL statements moved 24→23, with authority statements outside that count. Earlier estimates of 220 RT or an order-of-magnitude latency improvement were not demonstrated and must not be presented as measured results.

## Executed verification

- Before safety correction: 154 passed, 1 purge regression failed in the original 155-test set.
- Safety-corrected PostgreSQL/S3/job regressions: 169/169 passed, no skips.
- Authentication/admin/password/deadline/revocation race repeat after query merge: 67/67 passed.
- Web top-level: 345 passed, 0 failed, 1 existing optional skip; server/worker type checks passed.
- Actual root sandbox + host-native gate with an independently built manifest: 26/26 passed, including active snapshot inode/mtime mutation cases. Initial `sudo -n` stopped before testing; the later run used the previously user-authorized local helper and did execute. Do not keep the superseded blocked status as the final verdict.

Reproducible benchmark: `apps/web/test/performance/p0-hardening-benchmark.test.mjs`. It requires the explicit synthetic-local-only opt-in and disposable PostgreSQL/RustFS configuration. Performance targets for full save latency, capacity and long-running editor sessions remain open.
