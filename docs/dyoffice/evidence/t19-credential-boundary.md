# T19 incoming credential boundary candidate

This is a preparatory transport component, NOT a completed MCP integration.

`createMcpCredentialReader` accepts one opaque 32-byte base64url external token from a Bearer header. Duplicate Authorization headers, combined credentials and access_token query fields fail closed. URL token compatibility is restricted to exact `/dev/mcp` and explicit development/test startup opt-in; production or unknown environments reject opt-in. `/mcp` never accepts URL credentials. The error does not echo credentials.

The parser returns an external-token credential, never a principal. No route is mounted. No browser session can be used as an external credential through the current business transaction adapter. Before wiring a route, implement separate token hash persistence, audience/expiry/revocation checks, token scopes intersected with live owner roles, transaction-bound subject derivation and recheck, and token-bound MCP sessions. Do not pass the returned token to the browser session resolver.

Required subsequent work: official SDK protocol/client verification, OAuth/Bearer discovery, two real harness clients, cancellation/reconnect/deduplication, own-file tool authorization, absent-editor failure, outbound T18 permission/SSRF controls and no-credential logging. The URL compatibility endpoint is not a standard OAuth endpoint.

Validation in isolated candidate: Node 24.22.1, 5 tests passed, focused TypeScript strict check passed. Initial tests failed because component did not exist. No live token database, MCP server, browser or client end-to-end test has run. This does not satisfy T18/T19 completion.
