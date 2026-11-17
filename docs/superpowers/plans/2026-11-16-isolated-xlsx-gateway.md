# Isolated XLSX package parser and save planner

Scope: replace API-process gateway execution with a self-contained Node bundle
inside the existing systemd transient-unit sandbox. Preserve original desktop
mapping, Rust archive writer, File API revision/lease checks and fail-closed
startup. No worker_threads/plain child fallback and no Actions settings changes.

1. RED: prove package/plan did not receive request AbortSignal.
2. Extend trusted host launch to hash-check and copy a bounded Node script;
   reuse private root, dynamic UID, network/seccomp/cgroup/wall-limit policies.
3. Bundle a two-command gateway runner. Input workbook/parts/output stay <=32 MiB;
   request <=4 MiB; plan <=256 unique safe paths. Serialize/validate Maps across
   a file protocol, never deserialize executable code.
4. Wire runtime to the sandbox adapter, register active calls for shutdown,
   propagate request cancellation, reject legacy in-process configuration.
5. Run pure protocol, cancellation, original gateway behavior and TypeScript
   checks. Real systemd package/plan and active-process cancellation tests must
   run on the supported CI host. Unsupported hosts must fail, not skip/fallback.
6. Independent review; draft only while real-host gate is unverified.

The trusted Node executable may be up to160 MiB (Node24 here is127 MB); Rust's
existing64 MiB executable limit and every untrusted32 MiB file limit remain.
The JSON wire result has an independent32 MiB cap; base64/escaping overhead may
reject a near-limit plan explicitly rather than allocate unbounded memory.

Integration update: real-host acceptance remains unverified, but is not a
prerequisite for integrating this experimental fail-closed code. It must not
be described as verified systemd/openEuler or production isolation.
