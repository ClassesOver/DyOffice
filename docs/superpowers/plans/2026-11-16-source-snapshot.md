# T15 bounded query snapshot foundation

Scope: implement the existing T15 QuerySnapshot/provenance requirement independently of unfinished T12 credential and source authorization services. Do not register a route, open a connection, or relax default deny.

1. Add failing unit tests for schema/unit/timezone preservation, deterministic hashes, row/byte limits, malformed values, immutability and truncation.
2. Add shared QuerySnapshot types and a pure server snapshot builder. Hash only normalized evidence, never connection credentials or raw SQL. Retain numeric values unchanged.
3. Run focused tests and strict TypeScript checking. Obtain independent review. Record that real PostgreSQL role denial, HTTP SSRF controls, source ownership and connector acceptance remain pending. No T15 closure claim.
