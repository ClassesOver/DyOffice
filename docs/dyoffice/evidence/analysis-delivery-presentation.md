# Analysis delivery presentation (PR 134, plan G)

This SaaS-only slice connects coding completion hints to an owner/session-bound
server receipt before presenting any committed references. The adapter's delivery
object is only a task/command lookup hint; its summary, files and URLs are not used
as evidence. No T16 standalone question/answer entry or Electron dependency is added.

## Security boundary

- Receipt task/command identity, bounded fields, artifact provenance references,
  sizes and checksums are validated. Only projected metadata is shown, never rows.
- React text renders agent identity, untrusted summary, source/version/row count,
  explicit truncation, limitations and distinct file/snapshot/query/runtime hashes.
  Server-confirmed commit does not make model conclusions trustworthy.
- Downloads require an explicit click. They use a fixed same-origin artifact route,
  the original session proof, no redirects, bounded streaming and the raw file-byte
  SHA-256. Authorization is checked before and after the byte read. Files are inert
  octet-stream attachments, including HTML/SVG, not active previews.
- Generation/disposal is checked across asynchronous reads, hashing and save.
  Client replacement or component unmount also invalidates pending UI saves.
  Authorization/download errors clear previous metadata. Disposal notifies mounted
  subscribers; opening the panel and returning window focus revalidate receipts.
- Artifact requests with a supplied empty/invalid/stale proof reject before storage.
  Legacy headerless attachment navigation remains owner-authenticated and origin
  checked, preserving existing attachment links without expanding access.

## Local verification

All fixtures are synthetic. The targeted real PostgreSQL test uses the actual
session-bound shell client, Fastify routes, RLS-backed receipts, artifact commit and
bytes. It verifies session replacement, logout, wrong owner, empty/stale proof and
headerless owner attachment behavior. The accompanying existing receipt recovery
regression also passed (2/2 total). Temporary database/storage were cleaned and the
private PostgreSQL instance stopped.

Focused regression cases cover forged hints, cross-task references, raw rows,
invalid URLs/oversize, corrupted bytes, reauthorization failures, disposal during
hashing, clearing metadata, escaped XSS strings, click-only downloads and late
completion after client replacement. Meaningful red-to-green evidence includes
missing delivery callbacks, invalid proof previously accepted, stale metadata on
disposal, and old-client downloads previously clicking after replacement.

Evidence logs and exact frozen hashes are supplied with the review handoff. Full
Web unit and shell suites, default Web/Docs/Sheets type checks and four-format Vite
build are the controlled validation scope, not the restricted full CLI suite.

## Remaining acceptance boundaries

This does not validate an external model, a second real third-party harness,
browser automation or desktop parity. Session revocation is rechecked on focus,
opening and download, not pushed instantaneously to an idle open page. Analysis
contents remain untrusted and there is no inline file execution, insertion into the
editor, or automatic document save. Existing per-task server authorization remains
the authority; no additional data-source/model access has been enabled.
