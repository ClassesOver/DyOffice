# Settings B coverage audit (bd385f3)

Existing production surfaces use B classes: WorkspaceSettings account/security and
preferences (`personal-settings-b.css`), skills (`personal-skills-b.css`), members
and trash (`ManagementList`/settings primitives), and sources/global configuration
(`connection-config-b.css`). These are implementation observations, not a claim
that every dialog has passed visual acceptance.

Gap addressed here: Ant Design portals for Skill preview/replacement/deletion and
trash permanent deletion mount outside `.workspace-config-modal`. The main settings
ancestor selectors cannot style them. All four now use one body-portal-safe scoped
`settings-dialog-b` stylesheet: accent header rail, semantic surface/border/shadow,
scrollable bounded body, wrapping footer actions, focus-visible and narrow layout.
The shared chrome supports both AntD content/container class generations; the
current component DOM uses `ant-modal-container`. Existing parent-modal styles
that target only `ant-modal-content` remain a separate compatibility audit item.
No mutation handler, permissions, paging, unknown-outcome state or close guard is
changed. Skills remain 6-row frontend pagination; trash remains 10-row server
pagination. A long Skill body is scrollable content, not a paginated record list.

Other work remains separately auditable: browser-native confirmation prompts,
signed-out activation/reset form, upload and editor-internal dialogs. This patch
does not claim every project dialog is B-complete. Native browser prompts must not
be replaced casually because they participate in draft/unknown-result guards.

Verification: real component portal class assertions plus existing replace/cancel,
unknown-write, privacy clearing and list paging/refill tests. CSS checks only
prove token/scoping/responsive rules exist. Real 390px/1440px light/dark/brown visual
acceptance is still required; current Chromium startup fails with socket EPERM.
