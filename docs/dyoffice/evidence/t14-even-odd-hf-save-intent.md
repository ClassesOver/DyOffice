# T14 next actual App input: even/odd header flag

Base b9bd5cad. Only evenOddHf and evenOddHfDirty are included, not header/footer content, variants, section links, or all App inputs. No overlap with the Slides #113 implementation.

## Reproduced race and narrow fix

Two red regressions on the previous implementation reproduced an older native save marking complete despite an even/odd-header intent queued before React context commits. Both the intent-during-save and pending-at-capture cases failed with false instead of true saveIncomplete.

An independent synchronous boolean-pair store follows the previously reviewed page-color/mirror-margin pattern. Material setters produce a new opaque token; functional updates see the latest value; no-op keeps the token. The matching layout commit alone acknowledges readiness, cleanup/unmount revokes it. App uses that pair, supplies an optional context getter, and captureSaveMetadata adds pending/token comparison alongside all existing metadata checks.

The native serializer still uses evenOddHfDirty ? evenOddHf : undefined for evenAndOddHeaders. No layout algorithm, header-editor exit, HF content/links, document permission, database migration or provider changes. Old bytes can still be saved; newer intent is not consumed and the existing retry path can converge after rendering.

## Validation

Focused eight renderer test files: 100/100 passed, zero skipped. Covers React Suspense/unmount and synchronous store behavior; page-color/mirror-margin regressions; native metadata races and save retries; HF AI tools, page marking and HF pagination strips. A real store/save/DOCX disk-byte test confirms first snapshot remains without evenAndOddHeaders while pending intent survives, then simulated render acknowledgement and retry persist evenAndOddHeaders=true and clear dirty. The render acknowledgement in that byte test is simulated, whereas the hook test runs actual React.

The preceding mirror-margin baseline had a complete Docs run (6456 passed, 20 skipped); that is historical baseline evidence, not a claim that this new change has run the full suite. Existing jsdom canvas warnings do not constitute visual acceptance.

## Remaining limits

This pair's protection lives within one hook mount; no whole-App/cross-rebuild authority or all-export-path guarantee. Header/footer contents and links have their own asynchronous states and are not made atomic with this flag. Browser and desktop acceptance remain deferred rather than passed. Full T14 command mounting remains open.

Final native Docs entry TypeScript passed (1024 MiB cap, exit 0). Actual DOCX Vite build passed (768 MiB cap, 15.25s), retaining existing large-bundle warning. Independent reviewer found no new blocker and repeated four relevant files 72/72, exit 0; this includes HF sections and AI HF tools. No full-suite rerun is claimed for this incremental pair.
