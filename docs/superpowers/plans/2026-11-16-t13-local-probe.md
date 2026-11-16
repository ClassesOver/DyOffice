# Local Synthetic Provider Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Explicit, default-off admin synthetic probe through actual local app composition.
**Architecture:** Namespaced fixed-scenario routes wrap #78 pipeline; no generic AI endpoint. Existing T12 authorization and durable budget remain authoritative. A separate browser controller is not mounted into the in-flight T12 UI.
**Tech Stack:** Fastify, TypeScript, PostgreSQL, Node test, browser SSE.
**Spec:** docs/superpowers/specs/2026-11-16-t13-local-probe-design.md

## Global Constraints
No production enablement, real provider calls, free-form HTTP input, ordinary-user grant, fake HTTP-selectable transport or migration changes. No changes to T12 SettingsModal/Home/local-main/GlobalSettingsPanel. Start no heavy tests without resource coordination. Use isolated snapshot based on #78, unlink existing hardlinked files before editing.

## Review Focus
- Admin removal between HTTP precheck and dispatch must be caught by pipeline.
- Concurrent start and caller cancellation must not free an in-flight capacity slot prematurely.
- Empty/malformed explicit config must fail before routes can become partly available.
- App close during stalled stream must abort and settle cleanup before owned DB resources close.
- Browser disposal/session loss must not trigger a new request or show late output.

### Task 1: Fixed-scenario route and app wiring
Files: new server/src/modules/providers/local-probe.ts; modify server/src/app.ts; test/unit/provider-local-probe.test.mjs; test/local-integration/provider-local-probe.test.mjs.
Interface: optional LocalWebConfig.adminProviderProbe {profiles: readonly AdminPipelineProfile[]}; registerLocalProviderProbe(app,{pipeline,sessions,csrf,entries}). Namespace /api/v1/admin/ai-probe/turns; run body {modelId,turnId,scenario:'hello'}; cancel /:id/cancel. No free request body. Fixed system/user synthetic text, tools empty. Status path /api/v1/admin/ai-probe, safe entry IDs only.
- [x] Write route red tests: fixed body, no session/member/CSRF rejected before runner; additional input rejected; status no secret/profile; cancel same session.
- [x] Run targeted unit red, then implement strict route adapter with common existing SSE writer behavior (factor only if needed, keep existing adapter backward compatible).
- [x] Write actual app PG red tests: absent route default, malformed config fail, real session and profile/config/budget matching synthetic call over loopback HTTP, stale revision/member denial and replay zero resend.
- [x] Wire optional configuration and lifecycle disposal before DB close; run PG green using isolated 55449 service.

### Task 2: Browser probe controller, no T12 UI mounting
Files: new packages/browser-host/src/ai-probe.ts and test/unit/ai-probe.test.mjs; minimal reusable ai-transport serialization extraction only if required.
Interface: createAdminProbeClient with same-origin fixed endpoint and CSRF; explicit run(modelId,'hello',callbacks) returns cancel. No free-text argument. Single local active turn; dispose aborts. Tools received are rejected, never executed. No auto-run.
- [x] Red tests for fixed serialized body/no free text, repeated run, stop/dispose, late CSRF return, terminal once, tool rejection, same-origin enforcement.
- [x] Implement and pass tests; use controller in real HTTP integration from task 1.

### Task 3: Verification and review
- [x] Run unit directory, relevant actual PG tests, server/browser typecheck, boundary scanner serially.
- [x] Review exact diff/hash with independent security reviewer, fix findings red/green.
- [x] Document synthetic mock network vs real PG/loopback HTTP distinction, unmatched real upstream/GUI/ordinary permissions gaps.
- [ ] Only after confirmed tests/review create draft on #78, verify remote hashes; do not merge.
