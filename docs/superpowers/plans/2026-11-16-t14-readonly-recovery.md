# T14 Read-only Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task.

**Goal:** Recover minimal durable command status after a same-session refresh without granting historical editor write authority.
**Architecture:** A separate PostgreSQL reader locks the existing authority/lifecycle rows and verifies historical receipt provenance. Existing journal/writer and routes remain unchanged.
**Tech Stack:** TypeScript, PostgreSQL, node:test.
**Spec:** docs/superpowers/specs/2026-11-16-t14-readonly-recovery-design.md

## Global Constraints
No migration, HTTP/UI mount, lease or row mutation. Preserve writer receipt checks. Same owner/session only; never expose editor, session, arguments, claim or upload binding capabilities.

## Review Focus
- Locks must not perform the implicit expiry cleanup in lockAccount.
- Historical revision must not be replaced with current head.
- Session revocation waiting on locks must fail, not disclose stale-authority data.
- Damaged or absent receipt provenance must not produce committed success.
- A fresh editor can read status but cannot use old writer capabilities.

### Task 1: Separate read-only reader and PostgreSQL regression
**Files:** new server/src/modules/commands/postgres-recovery.ts; new test/local-integration/command-recovery.test.mjs (under apps/web).
**Interface:** createPostgresCommandRecovery({transactions,token}).lookup(fileId,commandId), minimal whitelisted DTO.
- [x] Write tests with missing-module import fallback and observe a real PostgreSQL red run.
- [x] Implement scoped locking, minimal projection and full historical receipt joins.
- [x] Run isolated PG/RustFS new tests plus existing abandonment/journal/HTTP/commit regression.
- [x] Run server TypeScript and independent security review; address demonstrated defects with tests.
- [ ] Record exact passed/blocked evidence, then ask parent before draft publication; never merge.
