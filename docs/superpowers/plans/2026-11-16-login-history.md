# Self Login History Implementation Plan

> **For agentic workers:** Native implementation with independent security review.

**Goal:** self-only minimal login history.
**Architecture:** immutable event attribution, live-session-bound SQL projection, cookie HTTP DTO.
**Tech Stack:** existing TypeScript/Fastify/PostgreSQL.
**Spec:** `docs/superpowers/specs/2026-11-16-login-history-design.md`.

## Global Constraints
No raw audit SELECT for auth; no legacy migration edits; no client owner/hash selectors; no invented historical attribution; exact PG CI required.

## Review Focus
Username rename/reuse and concurrent change; stale credentials; cross deployment/owner selectors; raw-table and function execution permissions; fixed bounds and secret-free DTO.

## Tasks
- [x] Add HTTP route contract tests; observe all three fail 404 before route implementation.
- [x] Add real PostgreSQL ownership, rename/reuse, throttle, legacy omission, limits, stale credentials and privileges cases. Local execution lacks PostgreSQL and is not counted as pass.
- [x] Add immutable failure/throttle subject attribution in `modules/auth/audit.ts`, with transactional users SHARE lock; wire sessions/throttle.
- [x] Add `0013_login_history.sql` and manifest; extend exact runtime function allowlist only.
- [x] Add service and HTTP projection with fixed DTO and query rejection. Focused HTTP tests pass.
- [x] Run Web/server typecheck and full Web unit suite.
- [ ] Independent SQL/attribution/permission review, address findings.
- [ ] Publish isolated draft for real PostgreSQL and combined UI CI only after review; do not merge target or bypass parent blockers.
