# PDF non-executable prepared context candidate

## Purpose and boundary

The PDF command/claim/lease/input stages do not supply a trusted tenant/runtime mapping. This candidate adds a persisted, revocable control-plane mapping for a PDF command without pretending it is the existing PPTX generation-zero outline request. It introduces independent `pdf_runtime_candidates` and `pdf_prepared_contexts` tables. Existing PPTX tables, profile constraints, functions, ExecutionPorts and DocumentExecutionRequest are untouched.

The fixed kind is `command-bound-non-executable`. PDF runtime candidates are limited to `pdf-edit-v1` and `test-approved`. Positive tests use an explicit synthetic mapping registered by the isolated migration owner. That record is a test trust fixture, not proof of an installed/certified runtime, OS isolation or production approval. No native process is started, no parser runs, no T06 output is written, and nothing accepts these observations as execution grants.

## Real source and transaction binding

Issuer input is only deployment/job/claim epoch/capability and scope/runtime references with versions. Owner, tenant, session, source revision, size/hash, command and lease are not caller-supplied identity. The private SQL helper first invokes the actual restricted PDF command reader, selects the real derived-file edit lease, then invokes native authority against those derived facts. Scope tenant comes only from a matching deployment+owner personal-owner registry row. Runtime identity comes from the separate PDF candidate table.

Issue holds existing user/session/job/file/revision/command locks, then lease and scope/runtime locks. Job UPDATE serializes the same job across reader/native authority lock sequences. It reruns authority after registry waits, compares all facts and command binding, persists canonical command JSON, digest and exact queue request hash, and checks DB-clock expiry again after insertion. A late expiry rolls insertion back.

Verify initially reads a context only to locate native identity. It authenticates the actual claim, locks registries and context, re-reads and compares immutable identity, active/version, then rechecks current real command/lease/source/auth facts and clock. No earlier successful observation can substitute for a later check. Expiry is the minimum of context, native claim/session/edit lease and registries; the TS adapter subtracts call duration and a safety margin. Separate calls do not provide atomic future authorization.

Registry changes automatically increment versions, including false→true or value restoration. Prepared contexts only transition active→revoked, with version increment; updates to payload, DELETE and TRUNCATE are rejected. Revoke is an exact ID/version operation, not runtime stop or lease cleanup.

## Permissions

All candidate functions use SECURITY DEFINER with fixed pg_catalog search_path and schema-qualified relations under a non-superuser, non-BYPASSRLS migration owner. Both tables use FORCE RLS with explicit owner-only policy. PUBLIC gets no table/function rights. A separate restricted LOGIN issuer receives issue/revoke EXECUTE only, not registry registration. The only additional worker privilege in this stage is prepared-context verify; its existing PDF claim-reader and native-authority EXECUTE privileges remain. Worker receives no issue/revoke, direct table or private prepared-authority helper privileges. Business role gets no new rights. Production migration/route/runtime registries are unchanged.

## Verification scope

New integration tests use actual PDF import, enqueue, restricted claim and business job-bound lease, not fabricated running jobs. Explicit registry inserts are labeled synthetic test trust. Tests cover positive issue/verify/revoke; no context insert for absent registry; versions and scope owner mismatch; command mutation with fully consistent digest and job request hash; opposite-kind registry rejection; real role ACL/owner/search_path audit; immutable context guards; revoke/verify overlapping locks in both orders; actual registry lock wait crossing expiry; real worker reclaim and T06 revision advancement. Existing PPTX authority tests are separate regression with their pre-existing synthetic DB fixtures, not new production runtime proof.

Source remains test-only. Debian13 x86_64/PostgreSQL17/local objects are the tested host stack. Ubuntu/openEuler x86_64, browser/desktop acceptance, real PDF runtime/context issuer provisioning and OS isolation are not established. No ARM target. A complete PDF execution protocol and trusted runtime provenance remain required before positive execution and post-execution authorization can be validated.

A regression exposed that merely validating command hashes in SQL could persist a semantically invalid command before the TS adapter rejected it. A real-PG RED case used a 45-degree command with consistent digest and job request hash. The private SQL helper now checks the canonical command schema before any context insert: exact keys, 1–100 operations, unique pages 1–100, safe integer multiples of 90 degrees, and byte-exact canonical encoding. Seven malformed/noncanonical forms with consistent hashes are rejected with zero inserted contexts. This duplicates a narrow pure schema at the SQL trust boundary; it does not parse PDF bytes or replace sandbox structural checks.
