# T00 Small-sample Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Record repeatable real local-auth API observations without claiming production capacity.
**Architecture:** A tested bounded sampling utility drives an isolated real-PG local app over loopback HTTP. Existing host CI runs it after correctness tests and uploads raw evidence.
**Tech Stack:** Node 22.23.5, existing Fastify/pg/local session fixtures; no new dependencies.
**Spec:** docs/superpowers/specs/2026-11-16-t00-performance-design.md

## Global Constraints
- Synthetic disposable CI only; no arbitrary target URL.
- Client-observed closed-loop latency, not section 8 server-side p95 or production throughput.
- Exact counts, errors, timeout, resource scope and source/fixture hashes must accompany results.

## Review Focus
- Empty/invalid samples must not become invented zero latency.
- Failures and 429/409 may not disappear from denominators.
- Concurrency must remain bounded; deterministic workload count survives async completion order.
- No credentials, cookie, request body or customer data in report.
- Unmeasured editor/AI/durability/capacity metrics retain not_run/blocked.

## Tasks
- [ ] RED/GREEN statistics and bounded sampler regressions.
- [ ] Add actual PG fixture, read-only route workload and resource/raw-sample output.
- [ ] Wire scoped CI command/artifact, preserving all existing gates.
- [ ] Independent review, exact-SHA real-service run, inspect report, report limits.
