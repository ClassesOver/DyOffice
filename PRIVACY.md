# DyOffice Web data handling

Last updated: November 17, 2026

## Scope

This repository targets a server-backed Web workspace. The desktop-only
statements in the historical notice below do **not** describe DyOffice Web.
In particular, Web document uploads and saves are not local-only operations.

## Web workspace

When you upload a file, the browser sends its name and size, followed by its
contents, to the workspace server. The server validates the upload and uses
the deployment's configured object store; file and revision records and
storage accounting are maintained server-side. Opening and downloading a
workspace file retrieves data from that service. Supported save operations
also send document data to the service. Rendering an editor or preview in
the browser does not mean the workspace file stays only on your device.

When an AI capability is enabled and invoked, its request can include prompts,
conversation messages, selected document context and tool results. Requests
are handled through the workspace's configured AI service/provider path.
The provider request builder supports user, assistant and tool content.
Do not assume a model request stays on the user's device merely because a
desktop notice mentions a local endpoint.

This source-level description is not a complete deployment privacy policy.
Before operating a service, the operator must disclose the actual hosting,
storage and provider recipients, retention and deletion rules, backups,
access controls, logging and any analytics in that deployment. This document
does not promise that deletion immediately removes all copies, that no
telemetry exists, or that a provider does not retain or use submitted data.
Users should consult the privacy notice of the specific service they use.

## Historical desktop notice (not a DyOffice Web policy)

The text below is retained as historical desktop documentation. Its references
to local editing/search, desktop settings, official packaged builds and
analytics describe that desktop context, not the behavior or configuration of
a DyOffice Web deployment.

---

# DyOffice Privacy

Last updated: November 12, 2026

DyOffice opens, edits, and saves documents locally. Document editing does not
upload files to DyOffice. AI features require a network connection and send
requests only when you use them.

## Search reranking (off by default)

File search runs on this device: the index is built from your local files, is
queried locally, and is never uploaded. If you turn on **Jev search
reranking** in Settings, a search with two or more hits whose judgement is not
already cached also sends one request to the decision-model endpoint you
selected. That request contains:

- the query text
- up to 20 excerpts (at most 1,200 characters each), with each excerpt's file
  name and the name of its parent folder

Excerpts are document content, so they leave the device whenever reranking is
enabled. The request is capped at 24 KB and the reply at 1 MB; judgements are
cached in memory for 30 minutes. If the endpoint fails or times out, the local
ranking is used unchanged.

Selecting a local endpoint — Kev, Rizzo Flow, or a custom URL on this machine —
keeps that request on the device. A custom URL pointing at a server you host
sends the excerpts to that server instead of a vendor. Turning **Jev search
reranking** off stops these requests entirely.

## Usage analytics

Usage analytics is enabled by default in packaged official builds, including
the initial app launch before the onboarding notice is shown. Onboarding
explains what is collected and where to turn it off.

You can disable reporting at any time under **Settings → General → Send
anonymous usage statistics**. An explicit opt-out is remembered and stops all
subsequent analytics events.

### Events and parameters

When enabled, the app sends these events:

- `install_first_launch` — marks the first analytics-enabled use of a newly
  assigned anonymous `client_id`; used for retention cohorts
- `app_launch` — no event-specific parameter
- `file_open` — `ext`, the file extension such as `docx` or `xlsx`
- `file_new` — `kind`, one of `docx`, `xlsx`, `pptx`, `md`, or `pdf`
- `login_click` — no event-specific parameter
- `login_success` — no event-specific parameter

Every event includes:

- `app_version`
- `platform`
- `os_version`
- `ui_lang`
- a per-process `session_id` derived from the process start time
- `engagement_time_msec` with the fixed value `100`

When available, the payload also includes `country_id`, the two-letter country
code from the operating system's regional locale. This can differ from the
user's physical location.

The Google Analytics 4 payload also uses a random install UUID as `client_id`.
The country code is sent through GA4's country-only `user_location` field; the
app does not send a city or region. Neither identifier is a Genspark account or
email address.

## Network information

Events are sent to Google Analytics 4 using the Measurement Protocol over
HTTPS. As the HTTPS recipient, Google necessarily sees the connection's public
IP address and transport metadata, and may use them for coarse geolocation and
security or spam-abuse processing. DyOffice does not add an IP address to the
event payload.

## Data not collected by analytics

DyOffice analytics never sends:

- document content
- file names
- file paths
- Genspark account identity
- email addresses

The analytics metadata is injected only into packaged official builds and is
not part of this repository. Source builds and forks without that packaged
metadata install a no-op tracker and send no usage analytics; all features work
the same.
