# T13 explicit local synthetic provider probe

Base: draft #78 f48c889f177f9423fbf000ff982097bfaee87339; dependencies #76/#74/#73 and merged #72. No migrations or ordinary-user permissions change.

## Intent and boundary
Exercise actual buildLocalApp, real session/CSRF and PostgreSQL authorization/budget using synthetic credentials and test-mocked DNS/HTTPS. This is not real upstream certification or production enablement. Normal application configuration leaves probe routes absent. Production local runtime remains rejected.

## Alternatives and decision
1. An isolated demo host misses actual app wiring.
2. Mount generic AI turns with a warning: rejected because HTTP clients could still send real documents.
3. Chosen: explicit local-only admin probe with server-authored fixed synthetic scenarios. Parent approved this boundary. No free-form prompt, history, tool schema, endpoint, header, credential or fake transport selection is accepted over HTTP.

## Composition
An optional typed adminProviderProbe configuration supplies deployment-controlled immutable profiles, using the existing globalConfigKeyring and restricted businessPool. Missing/empty/invalid prerequisites fail startup rather than partly mount. No environment-variable auto-enable or setting.enabled inference. Runtime profiles remain exact revision/provider/model/endpoint/IP bindings. Config_admin permission, current session, enabled chat setting, matching revision, sealed secret and preprovisioned nonzero budget are all required by the existing pipeline.

The application registers only namespaced admin probe status/run/cancel routes. Run accepts modelId, turnId and a fixed scenario enumeration. It constructs the canonical synthetic system/user messages and tools=[] on the server and reuses the established SSE writer/cancel semantics. Generic /api/v1/ai/turns remains unregistered. Admin precheck must precede SSE headers; the pipeline repeats authoritative checks around actual dispatch and events.

Status is authenticated config_admin-only, no-store, and exposes only experimental/disabled status and selectable entry identifiers with safe labels, never endpoint/IP, key material, budget account internals or owner/session identifiers. Absence of the feature does not leak a catalog via a public endpoint.

On close, dispose aborts active calls and clears known private key copies before pool close. No claim that arbitrary JS/native string copies are erased. Graceful teardown must not await an unbounded observer or retain configuration locks for the response stream.

## UI integration contract
Keep T12 SettingsModal, GlobalSettingsPanel, Home and local-main untouched while their branch is in flight. Provide a separate probe client/controller for future explicit admin panel integration. It only selects model/scenario, never imports editor state or executes candidate tools. No automatic probe on mount, configuration save, health check or page reload. Repeated start, stop, disposal, session loss and terminal-once behavior are tested. UI integration is a separate explicit dependency, not falsely counted as mounted GUI completion.

## Verification
Test disabled app has no probe/generic turn routes; invalid config fails closed; member/no-session/missing-CSRF/revoked session denied before network/budget; extra body fields including free-form text or endpoint rejected; real buildLocalApp with actual PG and loopback HTTP feeds browser transport and settles synthetic success once; unknown on truncation/cancel remains nonrefundable; repeated turn no resend; close aborts active call. HTTP test mock DNS/HTTPS installed solely in test process, no fake factory in public config. Known synthetic secret absent from HTTP output/error/log/audit. Independent review required before draft publication. No real model, external egress, ordinary-user authorization or vendor currency limit is claimed.

## Reviewed implementation refinements
Fastify preClose first calls pipeline.dispose, including abortAll on the outer turn coordinator. onClose repeats idempotent dispose and waits at most35 seconds for owned work before closeDb. Drain timeout fails shutdown and intentionally skips closeDb rather than pretending cleanup succeeded. Status labels are entry IDs, not configurable labels. Browser UI remains unmounted; its separate controller strictly validates the small probe event schema and counts raw response bytes before UTF-8 decoding.
