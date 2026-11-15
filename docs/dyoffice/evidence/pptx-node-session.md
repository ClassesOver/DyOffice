# PPTX transport-free session seam (partial T10 evidence)

Reviewed remote baseline: `01218869d0c9099d07b255f752b155ccbbc6b9a3`. No PPTX session/worker implementation existed at this checkpoint. T06 has only an independent local save-generation guard; server files remain read-only. This seam does not change that.

## Bounded design

The chosen path is a private Node in-process handle around existing `pptx-engine`, `pptx-ops`, and `pptx-render`. A browser-native full engine bundle was rejected because the engine imports Node crypto/zlib/fs; direct HTTP integration was deferred because identity, persistent revision CAS, jobs and sandboxing are separate unfinished dependencies. The Electron session-state module cannot be moved wholesale: it imports BrowserWindow/webContents, filesystem paths, system fonts, and a custom media protocol.

`createPptxSession(bytes)` exposes only `apply(expectedGeneration, ops)`, `render(expectedGeneration, slide)`, `exportBytes(expectedGeneration)`, and `close()`. Generation starts at zero and advances after successful native atomic setText batches. It is only an in-memory stale-command check, NOT a persistent artifact revision, fencing token or durable CAS. No HTTP routes, global sessions, identity decisions, capability changes or filesystem paths are introduced.

- Input is copied before awaiting and limited to 32 MiB. Shared metered zip-gate runs before native parsing with 1,500 parts, 8 MiB per part and 64 MiB total inflation ceilings. Native engine gates still run afterwards.
- Commands are copied before queueing. Only slide-local setText with text/bold runs is supported; arbitrary ops, part targets, isolation overrides and unknown fields are rejected. At most 100 ops and 256 KiB JSON bytes per batch, 32 queued operations per handle.
- Apply/render/export share a serial queue. Rejected calls do not poison later calls. Export returns native bytes with their captured local generation, and never calls commitSaved or acknowledges persistent saving. New edits queued after export do not enter that snapshot.
- Close invalidates queued calls and completed asynchronous exports; model references are released when in-flight work settles. AbortSignal checks are cooperative at boundaries, NOT CPU cancellation. There is no timeout, process sandbox, session TTL, global memory quota or protection against malicious JavaScript getters/proxies; this module must not be exposed to untrusted callers as a service.
- Rendering uses heuristic metrics and no media resolver. Data render output is detached from the model, but browser canvas, external hyperlinks/media, image conversion, font fidelity and PowerPoint visual re-open are not accepted by these tests.

## Tests and remaining integration

Native regression exercises edit/export/reopen, export before a queued edit, stale concurrent commands, queue recovery, invalid native batch, copied inputs/commands, detached output, close/pre-abort, strict field rejection, queue and payload bounds, and tighter inflation limits. The tests use real engine/ops/render, not fake engine results. Numeric generation is deliberately labelled local.

The separate existing `web-worker-roundtrip.test.ts` was corrected: the ZIP writer changes DOS timestamps, so whole ZIP byte equality is not a fidelity guarantee. Its deliberate +4 second Date test demonstrates different container bytes while all uncompressed entry bytes remain identical. Every package part is compared after no-op saves and rejected batches. Earlier same-second whole-file equality observations should not be generalized.

Run under the existing Slides Vitest suite (`npm run test -w @genoffice/slides -- tests/pptx-session.test.ts tests/web-worker-roundtrip.test.ts`). Isolated source-backed validation plus adjacent setText tests passed; strict source TypeScript checking passed. Full root npm test was attempted but stops at i18n (`vitest: not found`) in the Web-only environment, so no full-suite claim is made.

Before service integration: bind session handles to authenticated owners and artifact versions; add worker process/resource limits, expiry and admission control; choose authorized media URLs and font metrics; integrate T06 immutable storage/CAS/idempotency and ambiguous-save recovery; add native canvas edit/undo E2E and external PowerPoint acceptance. Never advertise PPTX editable capability based on this core alone.
