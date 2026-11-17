# XLSX parser isolation: current-target revalidation

This is the XLSX adapter of the unified document-isolation direction, not a
claim that DOCX/PPTX/PDF share this implementation yet. It replaces API-process
package reading and save planning with the existing systemd host boundary.
No ordinary-process, worker-thread, or in-process compatibility fallback exists.
Legacy gateway-module configuration is rejected. Production remains disabled.

## Verified locally

- Reapplied the six existing-file changes from PR #67 against current target
  GitHub blobs; no conflicts. New files were fetched from #67's exact head.
- Refreshed the changed native XLSX adapter, revision service and request-snapshot
  test; subsequently refreshed the #118 gateway-import changes.
- Final adapter, cancellation, request snapshot, admission, host contract and
  API boundary and #118 transfer-admission queue suite: 53 passed, zero failures/skips.
- Current base is d2cb5b18 (after #118). Its 47 relevant changed gateway/web
  files were refreshed from GitHub before rebuilding and testing.
- Host capacity accounting: 4 mocked-controller tests pass. Before the fix,
  3 failed and 1 passed. Unknown/live cleanup retains both in-process slot and
  memory reservations; confirmed stop or prelaunch failure releases them.
  This does not implement cross-restart accounting or live orphan recovery.
- API boundary regression: removing the migration gives 1 failure/1 pass;
  restoring it gives 2 passes. This is an architecture regression, not proof of
  actual OS isolation.
- Runner bundle and worker strict TypeScript checks passed.
- The unit runner now explicitly enables Node module mocks; its capacity,
  gateway and API-boundary selection passes 15/15. This is test-only.
- The broader native-sheets run had 53 passes and 25 failures. The unabridged
  local log is retained: 20 missing native host-manifest failures and 5 missing
  disposable PostgreSQL admin setup failures. No failed test was removed or skipped.

## Unpassed release gate

All three real-host gateway tests fail HOST_BACKEND_UNAVAILABLE in this
uid-1000 environment with codex as PID 1 and no active systemd. They must pass
on a supported isolated host before declaring isolation acceptance. No root,
security setting, seccomp, SELinux, or sandbox bypass was used to force a pass.

For openEuler, test each supported architecture and release on a real host:
cgroup resource limits, transient unit properties, dynamic UID/private root,
network denial, credential exclusion, syscall policy, abort/timeout/process
tree termination, cleanup after crashes, and trusted runtime dependencies.
Keep SELinux enforcing. Unsupported properties or cleanup uncertainty must fail
closed; OS branding alone is not a capability probe. OCI/gVisor is a future
backend only, not an untested automatic fallback.

The runtime still permits experimental local mode only. Full runtime dependency
integrity, cross-restart/crash recovery, and shared scheduling for
all formats remain separate work. Do not mark these closed by merging this
XLSX migration. PR #118 is now the base; the in-process host-capacity fix is included.
