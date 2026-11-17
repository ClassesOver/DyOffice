# PR #113 safety corrections, recovered and independently rerun

Reviewed remote PR head: dcdc05ac888865cfb3d324be1a2f719c41bf45b3, still draft and not merged. Integration base: eeeb2261aee8d1a51b970f3a75ca5cc58be6495a. Three-way merge used original PR parent bc7f509, corrected PR content, and target. Existing target source was restored by exact Git blob hashes (226 relevant dependencies plus 37 later target paths). Remote tree construction uses the current target tree as base and replaces only the listed PR/correction paths, preserving every unlisted blob.

## Corrected boundaries

- fitWidthPx is optional in real Fastify open/slide schemas, matching actual bridge requests.
- Every native session operation requires server-renewed lease authority before and after work. Draft binding includes authenticated token digest, editorId and leaseEpoch; per-file serialization prevents overlapping draft operations. New session/lease cannot inherit another dirty draft. Authority loss discards the result/draft.
- Current head must equal request revision before native work; save request revision must equal baseRevision before export or staging.
- Matching bytes are NOT commit provenance. Export remembers its state generation, prepare binds the exact server-created uploadId, and adoption queries the database for that committed upload + revision receipt + base + originating authenticated session + current head. Same-hash other upload and same-owner other login are rejected. Unknown same-hash head movement intentionally conflicts; it does not silently discard a dirty draft. A new lease binding opens a clean persisted session.
- Ordinary fork is test-only with explicit NODE_ENV=test and unsafeTestOnly, and a sanitized child environment. buildLocalApp rejects any slidesHost/nativeSlidesDirectory configuration in every environment. No production/runtime flag permits bypass. Real systemd/openEuler isolation remains unimplemented/unverified, not passed.
- History budget accounts for both stacks, model JSON and ZIP data, enforces eight entries/16 MiB, rolls back overflowing edits and render failures atomically.
- Initial no-lease UI does not mount the native parser/editor. It shows persisted download and explicit takeover. Successful takeover refreshes the head before first mount. Losing the lease after mount preserves the dirty renderer as read-only, with save/takeover blocked until safely resolved. No read-only parser compatibility route was added.

## Evidence

- New service/real Fastify/actual bridge regressions: 12/12. New same-hash provenance regression was observed red (missing expected rejection) before implementation, then green.
- Real PostgreSQL + local object store: 2/2. Includes takeover, old/new base fences, exact staged-upload provenance and same-owner cross-session rejection. Native handle is intentionally mocked here.
- Full native-slides suite: 30/30 before final entry-only changes, including real PostgreSQL and real test-only fork. Also repeated successfully through documented npm test:native-slides script. This is NOT OS sandbox evidence.
- Final entry tests: 4/4. No-lease parser-mount regression observed red before correction; clean/unknown receipt flows, first authorized takeover mount and dirty lease-loss covered. Heavy renderer is a seam stub with real entry + React/jsdom; not visual browser acceptance.
- Native history: 21/21.
- Standard npm test --workspace @dyoffice/web: 243 passed, 0 failed, 1 existing skipped, 244 total. This snapshot inventory is not the original author's claimed 266 tests.
- Server, PPTX worker and final Slides entry TypeScript passed. Actual Slides Vite build passed (large bundles remain).
- Early entry type/build checks exposed missing local snapshot messages and dependencies; exact PR-head messages restored and local installed package references filled. No dependency source stub or ambient-any workaround added.

## Integration status

Local correction patch and file SHA256 manifest only; not pushed or merged. Independent reviewer reported no new safety bypass and repeated PG/native/safety regressions 45/45 (including final entry changes), plus native worker Vitest 3 files / 25 tests. Whole latest-target regression must run after integration. Browser visual/desktop PowerPoint and real openEuler/systemd acceptance are deferred, not passed. Formal PPTX HTTP mounting stays fail-closed; this is safe disabled plumbing, not complete deployable T10.

## Current-target integration

Preserved target selection API and canonical/alias ambiguity rejection before atomic mutations. Kept target eight-entry history bound while retaining the stricter 16MiB byte bound. Target selection/history/ambiguity tests were retained under the richer response contract (no old-response compatibility shim); native session plus PPTX job tests pass 44/44. Preserved command_revision_guard-to-409 translation, provider-probe route configuration, isolated XLSX gateway and host capacity fixes. All new formal PPTX mounting remains rejected.

Final integrated checks: real PostgreSQL/native/service suite 45/45, native session/job suite 44/44, standard web suite 304 passed / 1 skipped / 0 failed, server/entry/PPTX worker TypeScript clean, real Slides Vite build passed. These checks run against the locally assembled current-target candidate. No OS sandbox/visual acceptance is claimed.
