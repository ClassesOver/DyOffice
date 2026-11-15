# dyoffice Web adaptation

Development happens directly in this cloned GenOffice repository on `feat/dyoffice-web`.

Confirmed scope:

- Native DOCX (Word), XLSX, PPTX and PDF only.
- Personal workspace; no teams, team membership or team permission UI.
- Data-source management and personal preferences remain.
- Models, credentials, service endpoints and global defaults are administered through Admin.
- MCP supports HTTP only; no stdio command/process configuration.
- Use the latest cloned GenOffice engines; reference sm PR #245 for browser integration and design.

Upstream: genspark-ai/genoffice `19a389b39be75f611ec21dcda4a7b91a658239d2`.
Reference: ClassesOver/sm PR #245 `beeb717b31e2201cc1e541c54b2f750f606d99e2`.

## Development status

Implemented a runnable Web service and personal/Admin interfaces in `apps/web`, HTTP bearer access boundaries, encrypted credentials, preferences, file import/download, HTTP data-source configuration and official SDK HTTP MCP handshake/tool discovery. Root scripts: `dev:web`, `start:web`, `test:web`.

Native browser editor adaptation and model-assisted editing have not yet been implemented. The upstream desktop apps and engine packages are preserved for reuse; the current Web interface does not claim to edit Office documents. Detailed startup instructions and remaining work are in `apps/web/README.md`.
