# T13 pinned HTTPS transport preparation (unmounted)

Depends on #74 head7859446357cc1b8639d8c14187cf240605a259b8, stacked on #73.
This stage exports a transport primitive only. Nothing is mounted or enabled.
No real provider service or user document was sent, and no financial authorization
or ordinary-user credential permission is added.

## Scope
A final private body snapshot is SHA256 checked against the durable dispatch scope
before DNS. Its digest means exact wire bytes, not a logical request before model
or protocol transformation. HTTPS options are built from explicit fields only.
Exact profile identity and endpoint are required; DNS answers must all be canonical
IPv4 in an explicit trusted peer allowlist and pass a deliberately conservative
public-address filter. All IPv6 (including IPv4-mapped) and broad special IPv4 /8
ranges are rejected. This may reject legitimate providers; it is not universal
IPv6/public-address support. Profile/IP allowlists are copied at construction.

A per-call lookup always returns the selected vetted IPv4. It never re-resolves.
HTTPS uses family4, autoSelectFamily:false, agent:false, normal hostname/SNI
verification and rejectUnauthorized:true. Before end(body), the actual TLS socket
must be authorized and match the pinned peer IP and port443. No headers are flushed
or body written earlier. A response is not consumed until the request finish event,
preventing cleanup from overwriting a body buffer still being written.

There is no retry or redirect handling: every status other than200 rejects. SSE
media type is checked exactly; compression is rejected. Fixed headers16KiB, input
1MiB, bounded response bytes, total timeout, caller abort and concurrent-operation
admission apply. Pending OS DNS or a trusted downstream callback keeps its capacity
slot until it actually settles, even when the caller already sees timeout. A
callback started before abort may continue; no new callback starts after abort.

Raw provider errors, bodies and Authorization never enter diagnostic messages.
Known private buffers are zeroed on cleanup, but the Authorization JS string and
native/TLS copies cannot be guaranteed erased. No such claim is made. The caller
must compose this primitive behind #74's unique durable takeForDispatch; the scope
itself is not a cryptographic authorization capability or a client DTO.

## Verification limits
36/36 isolated unit tests and strict targeted TypeScript pass. Tests mock Node DNS
and HTTPS I/O boundaries; they inspect lookup/TLS options, exact body bytes, peer
checks, redirected/error statuses, mixed/private/mapped addresses, mutation races,
header rules, pending cancellation/timeouts, retained capacity and byte limits.
RED/GREEN captured premature success before request finish and malformed-signal
cleanup leaking an arbitrary error; both now regressions.

These mocks DO NOT establish real resolver/TLS certificate/hostname/peer behavior,
DNS rebinding resistance in deployment, proxy-environment behavior, upstream protocol
compatibility, provider billing limits, or end-to-end T13 acceptance. Real authorized
integration and a reviewed server request builder/parser composition are still
required. No default route, actual external invocation, retry or refund is added.

The final body must also be canonical compact JSON with model exactly equal to the
profile and stream:true. Duplicate keys/noncanonical encodings and model/stream
mismatches reject before DNS (four explicit RED-to-GREEN regressions). The entire
Web unit directory passed161/161, zero skips; full server TypeScript passed in an
exclusive window. An earlier concurrent TypeScript attempt was killed (exit137),
not reported as a pass; unchanged dependencies passed after resource coordination.
Independent review reran the initial32 tests and inspected the final incremental
body checks; isolated mocks remain distinct from real DNS/TLS/vendor acceptance.
Admission here limits simultaneous in-process operations, not a distributed
requests-per-minute policy. Provider-specific rate policy and cross-process
coordination remain production integration requirements.
