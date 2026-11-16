# T07 native Docs React resolution diagnostic

Based on PR61 d5a9936. Original vite.docs.config.ts verified against GitHub blob eb079489b1c92654c08f28a24152cce35de845bd. No changes to prior PR61 save implementation, auth, database or security settings.

The earlier actual browser failure was `Cannot read properties of null (reading useState)` in the locale provider. The test environment has separate physical React 19.2.7 trees for Web and sibling Docs. A bounded Vite SSR build using the actual LocaleProvider reproduced this exact dispatcher failure. Changing only resolve.dedupe to react/react-dom produced `<span>probe-ok</span>` (exit0). This is real renderer/module evidence, not a full browser or save-flow acceptance.

Added portable build regression constructs two physical installed React copies in a disposable fixture, bundles a sibling hook component with the native Docs config's actual resolve settings, and renders it. RED null.useState; GREEN 1/1. Fixture cleanup removes only its newly created directory. Existing installs are untouched.

Minimal fix: native Docs config dedupes react and react-dom (including their subpaths through Vite's package resolution). No alias to a machine-specific node_modules path; no version change.

Remaining: full production asset A/B and actual browser delayed-save/document-switch scenarios, current-target integration, full Docs, and external Office. This fix addresses a reproduced dependency-layout hazard; it does not prove every prior browser white screen has this cause or that T07 is closed. No publish or merge performed.

Additional exact-candidate verification: docs bridge tests 9/9 passed. Required aggregate `npm test` actually ran; docx-engine 2239 pass/1 skip and pdf2docx 825 pass/7 skip. Aggregate exited1 in html2docx because Chromium failed to launch with `socket() Operation not permitted` in features and pagebg-restore suites (11 other files pass, 41 tests pass/70 skip). No security flags altered. This is not full repository pass. Independent reviewer reran the portable regression 1/1 and found no blocking issue in this narrow change. Full production build/browser remain pending.
