# T13 isolated synthetic probe page

Base draft #81 6996c33536617cb2666c0ab85dd661859fc2105f. No #79 Settings/Home/local-main changes, no migrations or production enablement.

## Chosen boundary
Parent approved a separate small vanilla DOM/TypeScript page rather than modifying concurrent T12 settings or mounting a general AI chat. Only a configured local runtime with both adminProviderProbe and an explicit built probe asset directory may expose `/admin/provider-probe/` and its build assets. Default remains absent. Directory without pipeline config fails startup. All HTML/assets GET/HEAD requests authenticate a current config_admin session before static lookup; URLs cannot select arbitrary filesystem paths. Existing createStaticAssets provides safe built-only serving. Strict self-only CSP, no inline script, no external links/resource dependencies, no-store, frame-ancestors none. Production local app stays denied.

## UI
A clearly marked experimental fixed-synthetic-input page. Refresh reads capability/status, never starts a model request. Model selector uses the safe status IDs. Start is explicit; a running request disables start/model/refresh, enables cancel. Output uses textContent only, never HTML. No prompt textarea, document access, attachment, user-selected URL/key or tool execution. End/error/cancel states remain distinct; a completion is labelled a synthetic stream completion, not real provider certification. Pagehide disposes the controller and aborts requests. Stale status/request callbacks must not revive a disposed or canceled view. Repeated start and cancel are guarded by controller and disabled UI.

Use existing GET auth/csrf for current session proof, no new credential entry form or saved authentication. Access denied is displayed without exposing details; login remains the existing app flow. Provide a same-origin home link only. Small separate Vite bundle, no modification of shared package scripts required; no external fonts/images.

## Tests and limits
DOM tests cover explicit-only start, missing catalog, rendering hostile model/output as text, disabled repeated start, cancel, fail, pagehide cleanup and stale callbacks. Server integration tests cover default absence, missing configuration, unauthenticated/member asset access, admin built assets and CSP. A real browser uses an isolated local PG fixture and synthetic encrypted secret with test-only mocked DNS/HTTPS; no external provider traffic or real document. Real GUI validates start/result, cancel/restore controls, error display and member denial. This proves local wiring/interaction, not actual upstream TLS/model correctness or ordinary-member entitlement.

Independent security design review precedes implementation, then exact-code review and tests precede draft. Keep all dependency drafts explicit and unmerged unless separately authorized.

## Review refinements
The static adapter explicitly permits only index and manifest-allowlisted assets, not helper-added legacy/pdf pages. CSP uses default-src none, self script/style/connect and no unsafe-inline/eval. BFCache pageshow.persisted reloads a previously disposed page into fresh read-only status (never auto-run). Pagehide aborts pending CSRF fetches, each also bounded by5 seconds; controller cancellation remains best effort and cannot retract a dispatch. UI output is capped at65536 UTF-16 code units, distinct from network byte caps. Error/cancel terminal states cannot be overwritten by done.
