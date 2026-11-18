# Native Personal Settings Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for this isolated implementation.

**Goal:** Reuse the actual DyOffice settings dialog in the Web account entry, not a lookalike preferences page.

**Architecture:** Add an optional Web capability configuration to the original SettingsModal. The original desktop branch remains the default. Web account identity is explicitly personal development-token access, not Genspark login. Web preferences use the authenticated existing API and unsupported desktop capabilities stay disabled.

**Tech Stack:** Existing React/TypeScript, original SettingsModal/CSS, Fastify preferences API, Vitest and Playwright.

**Spec:** User's explicit request to preserve DyOffice UI, including personal settings; parent assignment to implement and provide real browser screenshots.

## Global Constraints
- Never expose API keys or represent development tokens as full account login.
- Do not mutate existing desktop defaults.
- Real API failures must remain visible, not be treated as saved.
- Original dialog structure/CSS and controls retained; unsupported sections are disabled.

## Review Focus
- Closing/reopening settings loads persisted preferences.
- Failed writes preserve persisted state and expose an error.
- Disabled sections cannot call desktop/Genspark APIs.
- Dirty editor tabs survive settings interactions and canceled logout.
- Real browser screenshots must load fully and be visually checked.

## Tasks
- [ ] Add a failing mount regression for original settings opened from Web account, unsupported sections disabled and no desktop API requests.
- [ ] Add optional Web configuration and wire account entry; reuse original controls for language/theme/author/autosave/assistant preference.
- [ ] Test successful and rejected persistence through actual adapter boundaries.
- [ ] Add browser reopen/failure/dirty protection assertions and loaded settings screenshots to current real Chromium CI.
- [ ] Run shell types/tests, boundary and Web regressions, publish isolated draft PR and await actual browser results and independent review.
