# T14 Explicit Recovery Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** A safe standalone recovery control surface that can explicitly fence an old uncommitted command.
**Architecture:** Reuse existing abandon state machine with a private one-shot transaction adapter. Optional authenticated HTTP handlers and a separate DOM control page expose only minimal lookup and explicit abandonment. Production registration stays unchanged.
**Tech Stack:** TypeScript, Fastify, PostgreSQL, node:test, DOM, esbuild.
**Spec:** docs/superpowers/specs/2026-11-16-t14-recovery-page-design.md

## Global Constraints
No old editor identity restoration. No relaxation of writer receipt. No claim that abandonment undoes local effects or a completed commit. No production route/navigation mount. No migration.

## Review Focus
- Commit-first returns exact verified receipt; abandonment-first blocks old publication.
- Current trusted policy and observed digest must both match under locks.
- Lost replies cannot cause automatic new mutation or false rollback messages.
- Disposal/stale responses cannot change a newer view or trigger abandonment.
- Cross-session/owner and forged browser payloads remain denied.

### Task 1: Server-only explicit abandonment by ID
- [x] Add failing PG tests for by-ID lookup/digest/policy/authority and commit race.
- [x] Extract reader-only private locks/provenance helpers; keep original writer unchanged.
- [x] Reuse abandonCommand via non-exported same-ID once-only adapter inside that transaction.
- [x] Verify state-only mutation, exact minimal projection, PG crash/revocation/legacy regressions.

### Task 2: Optional HTTP and standalone recovery page
- [x] Add failing route/client/DOM tests for auth/CSRF/explicit confirmation/stale and lost replies.
- [x] Implement fixed-endpoint client and optional routes; no production mount.
- [x] Implement text-only state view with explicit acknowledgement and abandonment control.
- [x] Build tiny isolated harness and test real GUI with synthetic fixtures if reachable.

### Task 3: Gate
- [x] Run combined PG, units, TypeScript and boundary checks against final files.
- [x] Independent review, then exact evidence including untested/general editor limitations.
- [x] Ask root before draft publication; do not merge or add production entry.
