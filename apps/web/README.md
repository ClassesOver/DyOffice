# dyoffice Web

This is the Web adaptation inside the cloned GenOffice repository, based on upstream `19a389b39be75f611ec21dcda4a7b91a658239d2`. UI and browser integration reference: ClassesOver/sm PR #245 (`beeb717b31e2201cc1e541c54b2f750f606d99e2`). Upstream engines and license notices remain in place.

## Run

Requires Node 22.12+. From the repository root:

```sh
npm install --prefix apps/web --workspaces=false --ignore-scripts
# Export distinct DYOFFICE_USER_TOKEN and DYOFFICE_ADMIN_TOKEN values,
# plus a persistent DYOFFICE_ENCRYPTION_KEY (see .env.example).
npm run dev:web
```

Open `http://127.0.0.1:3080` for the personal workspace and `/admin` for administration. Use the corresponding access token. Configuration is read from environment variables; `.env.example` is a template and is not loaded automatically. Persist the data directory and encryption key together.

## Current implementation

- Personal file import/download restricted to DOCX, XLSX, PPTX and PDF.
- Personal theme, language, author, autosave and assistant preferences.
- HTTP data-source configuration with encrypted credentials.
- Admin-only model endpoint/key configuration and enabled-model catalog.
- Admin-only Streamable HTTP MCP configuration and real connection/tool discovery using the official MCP SDK. No stdio subprocess transport.
- Separate personal/admin bearer tokens. The admin token manages configuration, but cannot read or modify personal files, preferences or data sources. Secrets encrypted with AES-256-GCM and omitted from read responses.

The development token server refuses startup when `NODE_ENV=production`, before reading or creating its data directory. This guard is not OIDC authentication or multi-user resource isolation; production identity and ownership controls remain unimplemented.

## Remaining implementation

Native browser editor integration, document save/revision lifecycle, model chat/tool execution, database connectors and query integration, source edit/delete/test UI, file folders/favorites/recent views, multi-user login and deployment hardening. Preference fields for editor features are persisted now and will be applied as each editor is integrated. This is a development foundation, not a completed Office editor.

Run `npm run test:web` for HTTP access-boundary and persistence tests. Runtime dependencies are scoped to this app so starting the Web server does not install or launch Electron.

## Web-only build baseline (T00)

Install without the root Electron postinstall:

```sh
npm ci --prefix apps/web --workspaces=false --ignore-scripts --include=dev
npm run typecheck:web
npm run build:web
npm run test:web:build
```

The pinned Vite build emits `apps/web/dist/index.html`, `admin.html`, hashed browser
assets and a manifest. The smoke test builds into a disposable directory, serves
that output over HTTP, and checks both pages and every referenced JS/CSS asset.
No Electron application or native engine is built or started.

This is a build baseline for the existing personal/Admin prototype, not the
four-format editor integration. `start:web` still serves the source `public/`
interface with the existing API server. The static build alone has no API; a
production static-host/API integration is still required. Type checking currently
covers BrowserHost and Web contracts, not the legacy JavaScript prototype or all
upstream renderer packages. HTTP smoke checks do not replace real browser UI or
native document round-trip acceptance.

### Prototype storage and concurrency boundary

Run exactly one server process/application instance per data directory. The JSON store's queue protects only that instance; starting another instance on the same directory is unsupported and can overwrite metadata, even when both uploads return success. Do not use clustered workers, multiple replicas or rolling overlap with a shared prototype directory. There is currently no inter-process ownership lock.

Admin updates apply supplied sections against the latest state inside the instance queue; omitted sections and omitted keys are preserved. Concurrent updates to the same section remain last-writer-wins, not revision-checked. This is not the planned PostgreSQL CAS, document revision, lease, or idempotency implementation (T04/T06/T12). File endpoints currently import and download originals; they do not implement editing-save transactions.
