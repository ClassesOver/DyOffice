# Settings B implementation plan

Goal: apply approved B sidebar language to all personal settings without removing controls or safety state. Existing account menu/administrative routes remain separate permission boundaries.

Architecture: retain Ant Design Tabs with destroyOnHidden=false and every existing child instance; change navigation position and visual grouping only. Preserve preference client, password/session guards, skills import/delete guards and shell recovery. Scope CSS beneath personal settings only; semantic theme tokens support dark/system themes.

Inventory: account/profile, password, login sessions, login history, logout; language, theme, document author, autosave, assistant visibility; skill listing/filter/preview/install/import/replace/delete. Separate follow-on phases cover global provider/credentials/MCP/default capabilities, data connections/results, user administration, trash. No Home/editor redesign.

1. Add failing sidebar navigation, full-section retention and draft persistence test.
2. Implement sidebar headings, group general preferences and footer actions; preserve existing account/skills components.
3. Scope responsive visual styles to personal-settings-b; keep vertical keyboard semantics even when narrow layout stacks.
4. Run settings/security/skills focused tests and shell typecheck/build. Attempt real browser screenshots if environment permits; distinguish blocked screenshot QA.
5. Deliver local diff only for independent review, no push/merge.

Follow-up: theme uses native labelled radio previews, two-column form rows and right-aligned switches, with sidebar branding. Login history now uses the separately reviewed listPage({limit:5,after}) contract and server-owned cursor; previous page cursors are retained, totals are not invented, and refresh restarts at the first page. Shared SettingsListPager supports known totals or unknown cursor totals, while settings-primitives.css is reused by management lists. History list stays 260px desktop/240px narrow and focusable. Authentication client changes discard late prior-account responses. Browser regression covers 31 retained records, 1440/390 viewports and keyboard paging, but requires CI execution in this environment.

Personal list completion: active sessions use 5 rows per page over the complete existing response; this bounds UI rendering but does not add backend session paging. Personal skills use 6 rows per page over the existing owner-limited complete response. Recommended catalog uses the same 6-row pager. Session paging is disabled during confirmation/pending/unknown/revoked states; skill paging is disabled during writes/unknown/replacement/delete confirmation. Existing mutation/reconciliation paths remain unchanged.
