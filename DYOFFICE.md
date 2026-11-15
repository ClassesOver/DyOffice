# dyoffice Web adaptation

Development happens directly in this cloned GenOffice repository on `feat/dyoffice-web`.

Confirmed scope:

- Native DOCX (Word), XLSX, PPTX and PDF only.
- Personal workspace; no teams, team membership or team permission UI.
- Authentication for the production Web app uses locally managed usernames and passwords; Admin creates, disables, and resets accounts. No OIDC, Keycloak, SAML, LDAP or SSO integration. Sessions remain server-owned; external agents use separately scoped user API tokens. See `docs/dyoffice/local-account-auth.md`.
- Data-source management and personal preferences remain.
- All global settings are administered through Admin, following sm PR #245: models, image generation, image/video analysis, web/image search, search reranking, service endpoints/credentials, HTTP MCP and global capability defaults. Personal display/document/assistant preferences remain personal; reuse GenOffice provider and assistant implementations.
- MCP supports HTTP only; no stdio command/process configuration.
- Use the latest cloned GenOffice engines; reference sm PR #245 for browser integration and design.

Upstream: genspark-ai/genoffice `19a389b39be75f611ec21dcda4a7b91a658239d2`.
Reference: ClassesOver/sm PR #245 `beeb717b31e2201cc1e541c54b2f750f606d99e2`.

## Development status

Implemented a runnable Web service and personal/Admin interfaces in `apps/web`, HTTP bearer access boundaries, encrypted credentials, preferences, file import/download, HTTP data-source configuration and official SDK HTTP MCP handshake/tool discovery. Root scripts: `dev:web`, `start:web`, `test:web`.

Native browser editor adaptation, model-assisted editing, and production local account/password authentication have not yet been implemented. The upstream desktop apps and engine packages are preserved for reuse; the current Web interface does not claim to edit Office documents. Detailed startup instructions and remaining work are in `apps/web/README.md`.

## Reuse direction

Maximize reuse of GenOffice itself: its four native editors, assistant panels, agent-core execution loop, document tools, model providers, skills, preferences and file lifecycle. Adapt desktop dependencies to Web interfaces and move global model credentials/settings into Admin. sm PR #245 is a design and adaptation reference; selectively reuse missing capabilities such as data-source integration. The previously suggested Python/Agno replacement architecture is superseded. See `docs/dyoffice/reuse.md` for the corrected source map and constraints.
