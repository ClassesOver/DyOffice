# dyoffice Web

This is the Web adaptation inside the cloned DyOffice repository, based on upstream `19a389b39be75f611ec21dcda4a7b91a658239d2`. UI and browser integration reference: ClassesOver/sm PR #245 (`beeb717b31e2201cc1e541c54b2f750f606d99e2`). Upstream engines and license notices remain in place.

## Run DyOffice Web

Install the repository dependencies with `npm ci` using the Node version in
[.nvmrc](../../.nvmrc) and npm 10 or later. Web sessions use PostgreSQL local
accounts. The runtime supports development and isolated evaluation.

1. Create a dedicated PostgreSQL 17 database and the restricted logins
   described under [Database roles](#database-roles). In a migration terminal
   at the repository root, set `DYOFFICE_DATABASE_URL` to the migration owner
   connection and set `DYOFFICE_AUTH_ROLE`, `DYOFFICE_BUSINESS_ROLE`, and
   `DYOFFICE_DEPLOYMENT_ID`. Generate a stable deployment UUID once with
   `node -p "require('node:crypto').randomUUID()"`.

   ```sh
   npm run provision:runtime
   npm run bootstrap:admin
   ```

2. In a separate runtime terminal, build the browser workspace and create its
   environment file. Use `npm run build` to include the Office editor bundles.

   ```sh
   npm run build:web:shell
   cd apps/web
   cp -n .env.web-local.example .env.web-local
   ```

3. Fill in `.env.web-local` with the same deployment UUID, the restricted auth and
   business connections, the exact HTTPS browser origin, and a persistent CSRF
   key generated with `node -p "require('node:crypto').randomBytes(32).toString('hex')"`. Use an HTTPS reverse proxy for browser
   access. This template stores documents in `apps/web/.dyoffice/objects`.

   ```sh
   node --env-file=.env.web-local --import tsx server/index.mjs
   ```

You can also supply configuration through the process environment and run
`npm start` from the repository root. Node gives inherited environment
variables precedence over values in the explicitly selected file.

Check the running API at `http://127.0.0.1:3080/api/v1/health/ready`. See the
[native Worker setup](worker/HOST-RUNTIME.md) for optional background document
processing.

## Database roles

Create a dedicated PostgreSQL 17 database owned by the migration login.
Create separate auth and business logins. Set all three roles to
`NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`.
Runtime logins must have no role memberships and must not own application
tables. Provision passwords through your secret manager or the interactive
psql password prompt.

The root `provision:runtime` command installs migrations and grants for existing
roles. It revokes database-wide public CREATE and TEMP privileges. Supply the
owner connection only when provisioning or bootstrapping. The Web process
requires the auth and business connections to the same database and schema.
An optional `DYOFFICE_PASSWORD_BLOCKLIST_FILE` supplies a UTF-8 password
blocklist to both the bootstrap command and the service.

## Document storage and workers

The local account template uses a persistent filesystem directory. For S3, set
`DYOFFICE_OBJECT_STORE=s3`, `DYOFFICE_S3_BUCKET` and `DYOFFICE_S3_REGION`
and provide credentials through the AWS SDK credential chain. An S3-compatible
service can supply `DYOFFICE_S3_ENDPOINT` and `DYOFFICE_S3_FORCE_PATH_STYLE`.
Remote endpoints require HTTPS. Set `DYOFFICE_FILE_QUOTA_BYTES` to a positive
integer to override the file quota.

For queued native jobs, provision a separate restricted worker login using
`DYOFFICE_WORKER_ROLE`. The API and worker share the deployment ID and object
store. Worker build, queue and host requirements are in the
[native Worker guide](worker/HOST-RUNTIME.md).

## Workspace and admin configuration

The local-account Web API uses these routes for workspace and administrator settings.

- `/api/v1/workspace/*`: owner-scoped folders, listing, stars, recent activity and
  membership operations, using current cookie sessions, mutation CSRF and forced RLS.
- `GET /api/v1/settings/public`: authenticated safe catalog/default projection only.
- `/api/v1/admin/config`, `/check`, `/rotate-key`: `config_admin` operations with
  session/CSRF checks, optimistic revision validation, encrypted keys and audit.
  A configuration administrator receives no authority over another user's files.

`DYOFFICE_CONFIG_KEYRING` accepts JSON with `activeKeyId` and a `keys` mapping of key
IDs to canonical base64-encoded 32-byte keys. Provision it through the deployment's
secret mechanism, independently of CSRF/account credentials. Do not commit/log it.
Without a keyring, catalog/metadata access remains possible but secret writes and
operations requiring decryption fail closed. Blank/omitted keys preserve existing
ciphertext; explicit clearing is separate. Rotation is atomic with revision/audit.

### Required document backend selection (fail closed)

`DYOFFICE_DOCUMENT_BACKEND` is an optional deployment requirement, checked at the
start of the API process, native worker, and Sheets runtime composition:

- Unset: retain existing behavior. Native XLSX/jobs still require their explicit
  `experimental` flags, existing credentials, storage and verified legacy sandbox.
- `legacy-experimental`: explicitly retain that same behavior; this selector does
  not enable any native capability or remove existing production restrictions.
- `broker-required`: refuse startup with `DOCUMENT_BROKER_UNAVAILABLE`. The broker
  has no approved production runtime yet. No fallback to the legacy host sandbox,
  dependency connection, queue consumption or job claim is attempted.
- Any other value (including an explicitly empty value) is a configuration error,
  `DOCUMENT_BACKEND_INVALID`; omit the variable instead of setting it to empty.

The server logs only a fixed bounded reason. It does not print configuration,
credentials, paths or raw errors. This mode does not probe arbitrary binaries,
trust an operator-supplied runtime report, register candidate SQL, enable a
runtime, provide a broker socket, or claim Docker/four-format execution readiness.
An operator can use it to ensure a deployment requiring the future broker cannot
silently start on the experimental legacy backend. Existing deployments that do
not set the new variable retain their original explicit mode checks.

Verification exercises the actual worker/Sheets functions with configuration
access sentinels and socket-connect counters (zero), as well as the real server
entry in a child process (exit 1, fixed reason, no advertised listener). Legacy
negative startup tests remain unchanged. This is startup-denial evidence, not
positive legacy host, Docker, broker execution or production acceptance.
