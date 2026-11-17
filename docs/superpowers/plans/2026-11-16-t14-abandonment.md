# T14 Abandoned Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Read the design and this plan before editing.

**Goal:** Add a terminal, explicitly requested abandonment of an uncommitted fixed live-editor command, without claiming local undo or changing the durable document.
**Architecture:** Reuse authenticated transaction/lock order and keep binding tombstones. A forward-only 0022 migration extends the journal guard; service actions arbitrate atomically with T06. No UI mounting or target-branch change.
**Tech Stack:** TypeScript, PostgreSQL 17, existing T06 journal and Node test runner.
**Spec:** ../specs/2026-11-16-t14-controlled-ui-design.md, proposed explicit abandonment section.

## Global Constraints

- Fixed server tool allowlist: docs.replace_text.v1; no generic external-effect tool.
- Owner/session/permissions must be current. A command ID is not authorization.
- Terminal committed cannot be abandoned. Return verified committed receipt instead.
- Do not delete or clear bindings, upload references, objects or durable revisions.
- Old claim/report/bind/commit/replay requests must fail after abandonment.
- Isolated experiment first. Publishing requires exact #81 6996c335 + #82 integration, migration 0021 preserved, then 0022 registered and real upgrade rerun.
- No same-realm App reuse or UI entry in this phase.

## Review Focus

- Commit/abandon waiting on locks: one winner, never abandoned with a committed revision.
- Revoked owner/session or lock-wait revocation: no new action after authorization loss.
- Old epoch requests: no new file mutation; abandonment is a fencing action, not a lease takeover.
- Crash before outer COMMIT: rollback; lost reply after COMMIT: query/idempotently return terminal record.
- Bound upload with omitted/replaced sourceCommandId: cannot bypass the tombstone.

## Task 1: Core transition and forward SQL guard

Files: modules/commands/{journal,service}.ts; migrations/0022_command_abandonment.sql; focused command unit tests. Work in isolated t14-abandon; existing hardlinked files must be unlinked before editing.

Interface: `abandonCommand(envelope, digest): Promise<CommandRecord>`.
Allowed source states are pending_approval, approved, unknown_outcome and applied_uncommitted for the fixed tool; cancelled remains cancelled, abandoned_uncommitted returns itself, committed returns only its verified exact receipt. No local undo is implied. Preserve every immutable field/claim and bound upload.

- [ ] Add failing tests: allowed fixed tool, wrong digest/tool/session denied, terminal idempotency, immutable claim, all old methods rejected.
- [ ] Run RED before implementation.
- [ ] Implement service transition and `abandoned_uncommitted` type.
- [ ] Add forward migration preserving every 0020 constraint and guard except the explicitly allowed terminal transition. Do not edit 0020/0021.
- [ ] Run unit GREEN and focused strict TypeScript.

## Task 2: Real PostgreSQL arbitration and crash tests

Files: test/local-integration/command-abandonment.test.mjs; command upgrade tests as needed. Experimental migration may be applied explicitly after the base fixture while integration is prepared; this must not be described as registered upgrade coverage.

- [ ] Write real failing tests for state/SQL constraints and no binding deletion.
- [ ] Test commit-first and abandon-first using deterministic database lock barriers; verify journal/file/revision/upload/receipt agree.
- [ ] Test stale ACK/apply/undo/bind/replay and bound upload source omissions.
- [ ] Test cross-owner/session, revoked session while waiting, and old epoch policy.
- [ ] Test process crash before transaction commit and lost response after successful commit; repeat same command never mutates again.
- [ ] Run isolated PostgreSQL port55447 only, then stop it. Retain exact logs.

## Task 3: Integration and review gate

- [ ] Combine exact #81 and #82 trees in a new snapshot without changing either PR.
- [ ] Register migration0022 after0021; verify all previous migration bytes unchanged.
- [ ] Run fresh database and upgrade-from0021 tests plus T06/commands targeted regression.
- [ ] Independent reviewer checks SQL NULL semantics, state immutability, no receipt forgery and lock/CAS boundaries.
- [ ] Report actual results and remaining GUI/recovery API gaps; draft only after parent receives evidence. No target merge.
