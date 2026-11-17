# T14 Controlled Editor Prerequisites and Assembly Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** Explicit approved single text replacement in a verified template, with real native PM and T06 durable verification.
**Architecture:** Harden reused transports, establish an exact-Transaction private native model, then assemble only after safety review. No full App or production default mount.
**Tech Stack:** TypeScript, native Tiptap/ProseMirror, strict DOCX profile, PostgreSQL/RustFS, isolated browser.
**Spec:** docs/superpowers/specs/2026-11-16-t14-controlled-editor-design.md

## Global Constraints
Strict #82 profile and complete part preservation; no guessed schema/style support. No original writer receipt weakening, lease takeover or replay after refresh. No undo UI in first delivery. Root evidence review before product entry.

## Review Focus
- Redirects must not move CSRF/document bytes to other origins.
- Profile/bytes must remain tied to the exact base before/after lease acquisition.
- Only exact authorized Transaction may change doc/selection/storedMarks.
- Recovery pointer durability precedes proposal; failures never clear uncertainty.
- Saving might already have committed despite client errors; never reapply or claim rollback.

### Task 1: Transport prerequisites
- [x] Red/green same-origin/redirect/CSRF/stream limits for http-commands.
- [x] Red/green shared T06 transport restrictions, preserving auth-only retry semantics.
- [x] Run broad affected unit/real HTTP/PG save regressions and independent review.

### Task 2: Private real-native model
- [x] Real DocParagraph tests expose external transaction/input weaknesses first.
- [x] Add optional exact dispatch hook; default adapter compatibility unchanged.
- [x] Private detached model consumes exact tr once and rejects appended/reentrant/late transactions.
- [x] Native positives and negative lifecycle tests; independent review.

### Task 3: Controlled experimental composition
- [x] After prerequisites pass, implement bounded candidate/approval/apply/save state machine.
- [x] Verified profile/hash before lease/propose, durable pointer before proposal, fresh realm recovery on reload.
- [x] Real PG+GUI normal/lost/conflict and stored bytes/parts/LibreOffice reopen evidence.
- [ ] Root review; optional draft only, no production registration.

## Verified prerequisite checkpoint

- Commands transport focused 8/8, session/lease/bridge-barrier/command unit suite 107/107, focused strict types passed.
- Independent reviewer ran session transport 12/12 and commands 8/8; native exact gate reviewed statically.
- Actual native DocParagraph model/fence subset 15/15. Model is narrower than profile: 32768 UTF-16 units per paragraph and 1 MiB aggregate UTF-8. Unsupported lengths must be disclosed, not silently trimmed.
- Real PostgreSQL + RustFS browser-file-host, command-http, revision-commit, LO and simple save regression: 41/41, no skips; log `t14-postgres/controlled-transport-final.log` outside tracked tree. Services stopped cleanly. Legacy LO tests use a synthetic paragraph node; they verify transport compatibility, not the new native composition.
- Native Sheets bridge integration lacked generated host manifest and is not included in that pass. No aggregate build or GUI is claimed.
- Assembly remains pending. Current client committed outcome is a state/digest/revision check; evaluating explicit original-writer provenance verification before calling it durable receipt revalidation.

Final experimental checkpoint: real GUI normal/503/explicit abandonment and same-origin two-file exclusion verified. Raw socket transport retry separately reproduced with exact DB revision/receipt counts; do not claim network-level no-retry. Docs focused types initially exited 137 but passed on the final exclusive serial run with the same 768 MiB heap. This is not full Docs/monorepo aggregate acceptance; no merge-ready/full-green claim. See evidence/t14-controlled-editor-prerequisites.md.
