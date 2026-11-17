# T14 recovery foundation on current target

Base: 5c777a0b5ecc4cc9cf33ae2dd24964511a3e66be. Narrow extraction of #84 abandonment, #85 read-only recovery, #86 explicit recovery actions/optional routes/control and #88 cancel settlement. Excludes #87 native controlled-template experiment and QA servers. Existing provider integration, #95 fixes, #100 disposal and T07 changes remain in the base. No provider, native App or production route registration changes.

Migrations 0001–0020 remain byte-identical to previously merged tree; 0021 matches current target blob; only 0022 is appended. Source overlay70 blobs verified: only manifest and command service intentionally differ from their fetched source. No production data was touched; local randomly scoped service fixtures only.

## Fresh evidence

- Actual PostgreSQL17 + RustFS:113/113, zero skipped, exit0 (146.4s). Command abandonment/read-only recovery/by-ID action/HTTP/provenance/upgrade, T06 revision, T05 purge and provider budget regression. Includes real lock waits, races, process exits, current-session revocation, historical receipt proof and v21-to-v22 migration ledger preservation. Services stopped normally.
- Final all Web unit-directory suite330/330, zero skipped, exit0.
- Ordinary Web serial suite280passed/1optional S3skip/0failed (37.1s), before the final one-line terminal-state client addition; final unit suite covers that addition.
- Full server strict TypeScript and focused client/recovery strict TypeScript exit0.
- Boundary scan999files/0violations. Isolated recovery module build exit0.
- Independent static review found no scoped blocker; independently repeated recovery route/UI19/19 and final command client14/14. Reviewer did not rerun the service suite.

## Integration defects caught

Old #84 service overwrote the newer writer getCommandOutcome provenance guard. An isolated old-implementation regression failed with Missing expected rejection for a forged committed receipt; preserving the current guard passed1/1. No weakening of writer identity was accepted.

Independent review found the generic command client did not recognize abandoned_uncommitted. New regression failed Invalid command response, then passed after adding only that terminal state to its allowlist. Execution still requires an unknown_outcome claim; terminal state cannot resume or replay.

Historical source evidence remains historical, not a claim its older test counts or GUI experiments ran here.

## Boundaries

Abandonment fences future publication and preserves immutable binding, not local undo or durable revision rollback. Recovery is same-session, current-owner authority with minimal projection, not a new writer capability or automatic cross-session recovery. Optional routes and control are unmounted. No real browser/desktop acceptance is claimed; owner deferred those as a gate. No arbitrary DOCX support, native tool adapter or complete T14 closure. CI is not a merge gate per owner, but protection must not be bypassed.
