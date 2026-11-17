# Explicit analysis insertion and separate save receipt

> **For agentic workers:** use superpowers:subagent-driven-development. This implements previously approved unified analysis plan G/H on PR134, without granting external office.write.

**Goal:** the user can explicitly insert a verified analysis text/table artifact into the currently bound Docs/Sheets document, then separately request a save and see its actual revision receipt.

**Architecture:** retain the session-bound receipt/download client, add a bounded inert-content preparation step, and invoke a registered native document adapter through original editor tools and save bridges. Artifact metadata/content cannot name a document, select a tool or execute code. No extra model call or authority is created.

**Tech Stack:** current TypeScript/React, original Docs/Sheets tools, SessionFileHost, existing browser-safe CSV parser, PostgreSQL/HTTP fixtures and existing CI browser suites.

**Spec:** unified-harness-data-analysis TaskG/H and Office collaboration Task12 boundary. Task12 external office.write remains disabled and separate. This is a user action through existing document authority, not a harness command.

## Constraints and decisions
- Explicit Insert and separate Save actions. Never save on insert, expand a grant, or treat artifact commit as document save. A pending analysis application also suppresses pre-existing silent autosave/blur/AI-completion saves until an explicit user save succeeds.
- First supported content: bounded UTF8 text/plain or text/markdown report as literal text, text/csv table as literal strings via the existing parser in opt-in strict mode. No rendering Markdown/HTML, formula inference, numeric/date coercion or truncation.
- Other media including SVG/HTML/code remain inert downloads. PNG is not enabled until original bytes-only insertion and bounded decoding are separately implemented; do not restore desktop URL fetching.
- Capture an internal opaque native target token before any download: document/editor instance, generation, base revision, lease epoch, current selection/edit state. Recheck after all awaits and at the original mutation boundary. Replaced client/target, navigation, invalid session, concurrent edit, lost lease or stale capture rejects.
- Data download retains service-side current owner/session authorization, same-origin/no-redirect, byte limits and checksum. Revalidate the same session/receipt before a save. Derived content never becomes an instruction.
- Applied is an uncommitted in-memory result. Save must be explicitly requested and return the actual revision from that accepted save generation. Unknown response/changed edit generation cannot be labelled saved. Do not blindly retry either mutation.
- No external models or previously blocked Codex/fullCLI/localChromium invocations. Browser acceptance uses authorized normal CI.

## Files / ownership
- Office worker: web-contracts analysis-document contract; browser-host registry; native Docs/Sheets original-tool adapters and save bridge receipts; focused native tests.
- Data content worker: browser-host analysis-insert-content; CSV opt-in strict scanner and tests; bounded preparation tests. Default CSV import behavior unchanged.
- Coordinator: analysis-delivery client, panel and assistant wiring; session/download/late-action tests and composed integration/evidence.

## Steps
- [ ] Test inert decoding and strict CSV against malformed inputs, controls, limits, trailing empty rows, formula-looking text; implement without a second parser.
- [ ] Test opaque capture ownership, stale edits/selection/revision/lease, dispose and replacement; implement original editor text/table application without autosave.
- [ ] Test real separate save receipts and ambiguous/newer-edit outcomes; retain original generation guards and user edits.
- [ ] Test panel explicit clicks, duplicate clicks, target/client replacement, disposal and authorization failures; expose applied vs saved/unknown status without model claims.
- [ ] Build a synthetic analysis delivery through real DB/HTTP and verify explicit insert, independently saved revision, and reopen bytes in existing Docs/Sheets CI paths. No upstream model is necessary to test this integration.
- [ ] Run relevant default types/build/tests and independent security review; exact whitelist update original draft134, rerun all final-head CI. Keep unsupported media and real-harness limits explicit.

## Scope preservation and validation notes
- New commits persist schema column names/types/units and timezone copied only from the already-authorized frozen input, never from harness-provided metadata. Legacy receipts lacking these fields are labelled incomplete instead of guessing values.
- User insertion appends fixed literal provenance labels, original snapshot/query hashes, truncation/row scope, units/timezone and explicitly model-supplied limitations. Both content and notes must fit the shared conservative bounds; rejection is whole-result, not silent truncation.
- Natural-language full-population claims cannot be mechanically proven correct. The harness receives explicit instructions against them and controlled display/insertion always identifies unverified content and truncated scope; model compliance is not a security guarantee.
- An expired result-only grant cannot query its source. Reading expired inputs never triggers a query. A separately explicit source-scoped query may create a new snapshot, subject to current source/session authorization; it must not silently replace the expired provenance.
- Local browser execution and real external harness acceptance remain unrun/restricted. Added synthetic browser fixtures are for the existing authorized normal CI only, with no new production test endpoint or external model request.
