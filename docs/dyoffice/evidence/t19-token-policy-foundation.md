# T19 external-token record policy foundation

Preparation only: no route, token issuance, storage, migration or business transaction integration. This pure function checks already-resolved trusted token/user records and intersects token scopes with live user scopes. It does not authenticate a bearer string, authorize a particular file, or return a browser session principal.

The transport from #48 uses distinct external-token credentials containing a 43-character base64url opaque value. This module deliberately does not parse or transform that value. Future persistence must look up its hash in a separate external-token store, never the browser-session store; the parser and this function are not yet wired together.

Checks cover deployment/owner/audience mismatch, auth_version, active account, password-reset requirement, revoked/expired tokens, malformed time/scopes, permission attenuation and immutable output. Only files:read and files:write are recognized; configuration administration grants no file scope. Expected audience and current time must be server-controlled. The result lacks sessionId and roles deliberately.

Validation: Node 24.22.1, four focused tests pass; standalone strict TypeScript check passes. Independent static review found no concrete blocker. No PostgreSQL or full repository test run is claimed. Before integration, implement trusted DB lock/recheck, safe actor/session bindings for leases/jobs, per-resource authorization and actual PostgreSQL revoke/expiry races. Do not report T19 or external-token persistence complete. Actions unchanged; no CI result claimed.
