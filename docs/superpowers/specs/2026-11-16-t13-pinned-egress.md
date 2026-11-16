# T13 pinned HTTPS egress preparation (design, unmounted)

Dependency: admin-only scoped credentials and durable one-time dispatch gate in
#74, head 7859446357cc1b8639d8c14187cf240605a259b8, stacked on #73/0020.
No ordinary-user authorization, real provider request or user document sending.

## Chosen bounded approach
Use Node HTTPS directly rather than fetch, to control one resolved peer and avoid
redirect behavior, retry layers, connection reuse and environment proxy adapters.
The transport is a server-private callback implementation, not an HTTP route.

A reviewed server caller prepares the final UTF8 request body first. Its exact
SHA256 is what the budget reservation binds, and the transport recomputes it before
DNS or dispatch. No additional model/tools transformation after hashing. Body is
copied at admission and limited to 1MiB; arbitrary client URLs/headers are unsupported.
Transport accepts only a scope whose deployment, entry, config revision, provider,
model, base URL and endpoint exactly match one trusted preconfigured profile.

Profiles require hostname HTTPS endpoints on port443, without credentials, query,
fragment or IP-literal hosts. Each includes a nonempty exact IPv4 peer allowlist.
DNS resolves once and every answer must be a permitted canonical public IPv4. This
first stage rejects all IPv6 (including IPv4-mapped IPv6), rather than claiming a
partially correct IPv6 classifier. It conservatively rejects entire IPv4 /8 ranges
0,10,100,127,169,172,192,198,203 and 224-255. This deliberately also rejects some
legitimate public addresses; availability is secondary to fail-closed behavior.
All returned addresses must also be in the explicit profile allowlist.

Choose one validated peer; the HTTPS request keeps the original hostname/SNI and
default certificate/hostname verification, rejectUnauthorized:true, family:4,
autoSelectFamily:false, a per-call lookup returning only the pinned address, and
agent:false. No second DNS resolution or shared connection. No insecure TLS option,
custom CA override, proxy, arbitrary Authorization, retry or redirect is exposed.
Every 3xx fails closed, including same-origin redirects. Only a200 SSE response
passes to the bounded response handling stage. Errors never include upstream body,
URL, authorization header, credential or original error cause.

## Resource and lifecycle boundaries
Fixed request/response byte ceilings, total deadline starting before DNS, a maximum
concurrent-operation count and caller AbortSignal apply. Timeout/abort destroys
request and response. DNS is not truly cancellable in Node; cancelled-but-pending
DNS retains its admission slot until it settles. Likewise trusted callback work
must not be treated as freed merely because an outer timeout fired. No automatic
retry, refund or new dispatch claim is allowed after an ambiguous outcome.

The Authorization header requires a transient JS string; no claim is made that
Buffer zeroing clears JS strings/native library copies. The key is never returned,
logged or included in a diagnostic. Existing #74 lifecycle holds apply.

## Verification boundary
Isolated tests mock DNS and HTTPS at the built-in I/O boundary, assert the actual
lookup/TLS options and exact body bytes, and exercise invalid/mixed answers,
IPv4-mapped IPv6, rebinding attempts, redirects, digest mismatch, cancellation,
timeout, concurrency and limits. They do NOT establish real DNS/TLS/vendor egress
acceptance. No production mounting or external sending is permitted by this stage.
A later authorized integration needs real certificate/peer/HTTP tests and complete
protocol request construction/parser composition under the same budget digest.

## Independent design-review refinements
Profiles/allowlists and the body are detached before the first await. The transport
hashes and writes that exact private body snapshot. The digest means wire-body
SHA256, not a pre-transformation logical request hash.

The API is send(scope,body,onChunk):Promise<void>; it consumes the response itself
rather than exposing an abandoned generator. Each read/DNS/downstream callback is
raced against total deadline/abort; pending underlying work retains capacity until
settled. The callback receives response bytes only, never credential data.

Max HTTP response headers are16KiB. Content-Type must have exact text/event-stream
media type, and Content-Encoding must be absent or identity. Authorization bytes
must be1..8192 visible ASCII characters without whitespace. No decompression.

HTTPS request construction does not flush headers/write/end. On its socket's
secureConnect event, require authorized===true, remoteAddress equal to the selected
canonical IPv4 and remotePort443; only then call end with the private body snapshot.
Default hostname verification and SNI stay enabled. The custom lookup handles both
Node all:true (single-element array) and ordinary address/family callbacks, always
using the same pinned peer. Isolated TLS-object tests cannot prove real TLS trust.

The final wire body must be canonical compact JSON, model must equal the profile
and stream must be true. JSON parse+stringify equality rejects duplicate keys and
noncanonical forms before DNS; no protocol rewriting occurs after digest validation.
