# T14 first real App persistence input: page color

Base d3db4d18. This is an actual Docs App change, but covers only pageColor and pageColorDirty, not the rest of its serialization inputs or a complete T14 editor mounting.

## Reproduced issue

Existing save metadata comparison reads committed React context values. A page-color intent queued before React commits its new render can be invisible when an older save returns, allowing the old snapshot to be marked clean. A regression reproduced saveIncomplete=false where true was required, before the correction.

## Narrow correction

Only this related pair moves to a synchronous external store consumed with useSyncExternalStore. Each material input update has a new opaque token. Layout commit acknowledges only the current token; old commits cannot acknowledge new input. Cleanup marks the matching token unrendered, including unmount. Functional setters use the current synchronous value. No-op values keep the token.

App supplies a dedicated optional getPageColorSaveState hook to FileActionContext. Existing captureSaveMetadata keeps its ordinary all-field comparison and additionally treats a pending captured snapshot, a pending current snapshot or a changed page-color token as incomplete. It does not block writing the older captured bytes: it prevents that older save from consuming newer intent, so existing save-until-persisted logic can retry after the render commits. No extra document permissions, command activation, provider or migration changes.

A global counter acknowledged by any React effect was deliberately NOT used: that could miss other pending lanes. This synchronous pair is one local input source, not evidence that unrelated setters, sub-stories, mutable objects or asynchronous producers are fenced.

## Verification

Regression red observed false vs expected true on original code. Final four renderer regression files56/56 passed, zero skipped: page-color state/React Suspense, metadata races, track-revisions flags and save-until-persisted. Includes pending intent during native-save callback, input already pending at capture, later settled retry, stale render acknowledgement, functional updates and unmount.

Native Docs entry TypeScript passed with1024MiB cap. Actual native Web DOCX Vite build passed with768MiB cap (15.63s). Existing large-chunk warning remains; no bundle-size optimization claimed. jsdom canvas warnings remain and are not a visual-rendering acceptance.

Independent reviewer repeated two-file39/39 before final cleanup refinement, then independently repeated final page-color2/2 and reviewed cleanup/token logic. Initial focused types caught false-literal narrowing of dirty; explicit Readonly snapshot type corrected it without relaxing checks. All failure logs retained.

## Remaining boundaries

The store lives within one App hook mount. It is not the shared whole-document generation fence from the unmounted native command primitive and does not carry approvals across App reconstruction. Other metadata/DOM/story/lifecycle inputs still require individual integration. This protects the ordinary save clean-state decision for this input pair; it does not claim every export path, every serializer context or full App dirty-state is closed. No real browser/desktop UI acceptance in this slice; owner deferred those gates, not waived honest reporting.
