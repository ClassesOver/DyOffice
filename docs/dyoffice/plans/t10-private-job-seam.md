# T10 private one-shot job seam

Base: target `61237d8`, retaining merged #92 native session. The target diff since #92 does not alter PPTX session/engine/ops/render or Slides test configuration.

## Scope and decision

Reuse the original PPTX session in a private, one-shot byte processor. Do not expose the in-process parser in HTTP, reuse XLSX paths accidentally, or label it an isolated worker. A direct public session route would bypass T08 process isolation and T06 fencing. Generalizing the host/SQL protocol in this change would couple an untested executable ABI and persistent migration to a small native processing slice.

## Plan

1. Add failing real-native tests for edit/export/reopen, byte snapshots, busy rejection, malformed/oversize/privileged request fields, cancel and capacity recovery.
2. Add exact versioned JSON request envelopes for roundtrip and existing whitelisted text ops only. Bound 32 MiB input/output and 256 KiB UTF-8 request; no queued calls; sanitized errors.
3. Reopen generated output through ZIP gate and original parser before returning immutable-in-time byte result and digest. Local generation/digest are not a saved revision.
4. Run focused native regressions, strict focused TypeScript and report full suite separately; independent review.

## Remaining integration dependencies

- T08 host-process currently writes `input.xlsx` and reads `output.xlsx`; binary command allowlist and deployed executable ABI are XLSX-specific. A separately integrity-verified PPTX child entrypoint and fixed PPTX artifact paths are required. No user-selected executable, path, command, credentials or environment should cross that boundary.
- Add child IPC framing/output quotas, process wall/CPU/RSS limits, host capacity and cancellation/kill verification before accepting untrusted input. Per-processor BUSY and logical byte caps here do not provide these guarantees.
- Jobs route currently allows only `xlsx.roundtrip`. Define an explicit PPTX job type with server-side capability/type checks and any needed DB contract migration, not a disguised XLSX claim.
- T06 trusted executor must obtain fenced job authority and edit lease, read captured artifact revision, pass only bytes/request to isolated processor, stage returned bytes, and atomically commit expected base/lease/idempotency. Digest or successful reopen must never acknowledge persistence. Test cancellation, authority loss and conflicting revision before real routing.
- Browser selection integration, full editing tools and external PowerPoint acceptance remain separate and unverified.
