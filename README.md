# DyOffice Web

DyOffice is a browser workspace for DOCX, XLSX, PPTX, and PDF files, built on the
[GenOffice editor engines](https://github.com/genspark-ai/genoffice). Uploads
and saves send document data to the workspace service. See the
[Web privacy policy](PRIVACY.md).

## Getting started

DyOffice uses PostgreSQL 17 for local accounts and browser sessions. Use the
[Web setup guide](apps/web/README.md#run-dyoffice-web) to provision the database,
create the first administrator, build the workspace, and start the service.
For a containerized Web and DOCX evaluation with PostgreSQL, follow the
[Docker Compose setup](deploy/docker/README.zh-CN.md). Production startup is disabled.

When the service is running on the default port, run the readiness check.

```sh
curl --fail http://127.0.0.1:3080/api/v1/health/ready
```

A ready service returns `{"state":"ready"}`.

## Development

Run these commands from the repository root. The full SaaS build requires the Rust
`wasm32-wasip1` target. Install it with `rustup target add wasm32-wasip1`.

| Command | Purpose |
| --- | --- |
| `npm run build` | Build the Web workspace and all four browser editor bundles. |
| `npm start` | Start the Web server with configuration supplied through the process environment. |
| `npm run test:saas:entrypoints` | Check the default SaaS commands and workspace dependencies. |

For optional native document processing, see the [Worker setup](apps/web/worker/HOST-RUNTIME.md).
For development checks and reporting security issues, see the
[contributing guide](CONTRIBUTING.md) and [security policy](SECURITY.md).

## License

DyOffice is licensed under the [Apache License 2.0](LICENSE), with one
exception: the `ee/` directory is reserved for future enterprise modules and
is covered by the [DyOffice Enterprise License](ee/LICENSE).

The DyOffice and Genspark names and logos are trademarks of Mainfunc, Inc.
The Apache-2.0 license does not grant permission to use them (see section 6);
forks should use their own branding.
