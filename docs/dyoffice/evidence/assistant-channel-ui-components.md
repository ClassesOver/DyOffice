# Assistant channel component browser check

Executed 2026-11-17 using cached Google Chrome for Testing 151.0.7922.34, Playwright and esbuild. No browser or dependencies were downloaded. Temporary fixture source and runner are under `/tmp/office-channel-visual-entry.tsx` and `/tmp/office-channel-visual.mjs`.

This is a component fixture, not full Office editor E2E or real harness acceptance. It bundles the current worktree's actual `AssistantParticipants` and `AssistantChannelPanel`, their CSS, and shared theme tokens. All identities, applications and tasks are fixture data; the document API, model and harness are not contacted.

At a 360 px viewport with a 340 px component container, light and dark screenshots show separate Office, built-in Codex and external identities, a pending application, a running task and a completed task:

- [Light](assistant-channel-ui-light.png)
- [Dark](assistant-channel-ui-dark.png)

Actual browser clicks invoked these fixture callbacks in order: `start`, `approve:application-fixture:true`, `cancel:running`. Cancellation displayed `Cancelling`. The neighboring native Office draft remained `Unsent native Office message`. Browser page errors and console errors were empty. `document.documentElement.scrollWidth > innerWidth` was false. Both screenshots were visually inspected: labels and controls remain legible, long member names wrap or truncate, and the narrow layout does not overlap controls.

The fixture adds a heading and a neighboring native draft textarea for verification and disables the management panel's height cap only for complete screenshot capture. These are temporary fixture styles, not product changes. Screenshots total approximately 107 KiB.

The component fixture was rerun after task cards gained executor avatars and
plain-text result summaries. The completed fixture task shows “Total 60 CNY from
the authorized frozen result.” The running reverse task uses the Office avatar;
the completed external task uses its member avatar. The same click, draft, console
and narrow-viewport checks passed. This remains a component fixture.
