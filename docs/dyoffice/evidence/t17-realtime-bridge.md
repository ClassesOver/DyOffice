# T17 scoped realtime bridge — 2026-11-17

Status: local protocol/service integration accepted in the executed scope below. Default native editor entries receive notifications only; approved writer delivery requires an explicitly injected trusted T14 policy and an editor executor. This is not a claim that every tool in every document format is remotely executable or production accepted.

## Transport and authority

- Same-origin `/realtime` WS/WSS upgrade with a durable one-use, 60-second ticket. The ticket binds deployment, owner, login session, file and exact editor ID (or null for a read-only listener). Only the hash is stored. Reuse, wrong user/session, malformed URL, wrong Origin and expired credentials are rejected.
- Maximum 16 live tickets per owner; bounded cleanup; eight connections per owner and 64 per runtime. Pending upgrades are capped at eight with a five-second handshake timeout.
- Frames are capped at 16 KiB; inbound queued work is capped at 16 messages/128 KiB, outbound work at 64 messages/128 KiB. Ping/pong and bounded shutdown prevent a slow or abandoned peer from holding unbounded resources.
- State is read through the existing principal transaction, not from a caller assertion or a fabricated revision counter. The head is the actual revision UUID; notification generation is a strictly increasing per-connection sequence, reset on a fresh connection. Head and lease are read coherently; authorization/time is checked again immediately before queuing a frame.
- The default two-second bounded database poll discovers HTTP and separate-process saves. Every recipient reauthorizes; revoked sessions do not receive another user's or a cached file head. No unverified client file-event broadcast is accepted.

## Recovery and writer delivery

- Fresh connections receive current state and can query scoped T14 journal states for up to 16 pending IDs. No missed writer is replayed. A request ID binds each reconciliation response.
- Trusted server-only `dispatchToEditor` reuses T14 approved→unknown_outcome claim in a durable transaction and stores immutable routing proof. File/base/editor generation/lease/editor ID/session/connection epoch/digest/trusted tool policy must all match before sending.
- An exact WS delivery acknowledgment means accepted by that transport target only. It never means applied or committed. Existing T14 HTTP applied/bind receipts and T06 immutable revision commit remain authoritative.
- Duplicate command IDs, wrong acknowledgment identity, changed lease/editor generation, old connection epochs, timeout, disconnect and revocation cannot produce an automatic repeated write. Unknown results are reconciled against the existing journal.
- The browser bridge registers only when a caller provides a trusted command target. Native Docs/Sheets/Slides entries do not configure a writer by default: they show newer-head/reconnecting notices and may revoke local write authority, but never adopt a head, replace a draft or grant a lease from a notification. HTTP grants and saves remain unchanged.

## Executed verification

- Original unfinished draft failed to complete its first test in 35 seconds. That is a failed initial implementation/cleanup run, not successful acceptance.
- Final standalone real PostgreSQL + HTTP/WS: 28/28 passed, no skips or cancellations.
- Combined source/realtime/P0 branch real PostgreSQL WS tests plus TLS/WSS repeat: 29/29 passed.
- TLS test performs real HTTPS session login and cookie handling, WSS upgrade, fresh ticket/reconnect sequence reset, journal reconciliation, WS-offline T06 save and reconnect to the exact committed UUID. Exactly one commit is observed; reconnect does not duplicate it.
- Client reconnect/command target + server queue/decoder + lease barriers: combined 32/32 passed. This includes duplicate command handling, precise registration fences and disconnect-aborted late acknowledgment.
- Default notification editor bundles: Docs, Sheets and Slides builds passed. Browser boundary check passed (1294 files, zero violations before the final source-delete follow-up).
- Adjacent T14/RLS/T06 tests passed in the executed subsets; one separate S3 test invocation without configured S3 was blocked and is not counted as passed.

Tests: `test/local-integration/{realtime,realtime-tls}.test.mjs`, `test/unit/{realtime-server,editor-bridge-reconnect}.test.mjs`, and `test/native-sheets/lease-barriers.test.mjs`.

## Limits and remaining gates

- Official visible browser automation is blocked by the host workspace ownership check. No alternate live-browser backend was used to bypass it. Protocol, TLS and component tests do not replace visible browser acceptance.
- Trusted writer policies are injected explicitly; default native entries keep writer capability disabled. Per-format tool rollout needs its own executor/policy acceptance.
- Database polling is the implemented multi-process notification mechanism. No Redis pub/sub or guaranteed event-history replay is claimed.
- Closing WS does not alter the model transport implementation. No real external model call was made for this task; that remains T13/provider acceptance.
- Local runtime still refuses production admission until the repository's enterprise gates are satisfied.
