# Controlled LibreOffice template profile (not general Office support)

Source provenance: locally generated from two controlled text paragraphs using
LibreOfficeDev 26.8.0.0.alpha0, build 2c87e51eeaa2b413ff4ae097b2705eea1995d8e5.
The original DOCX bytes are retained as a fixture. This is a development build
and one source template, not a claim about stable LibreOffice or Microsoft Word.

The new profile is separate from the original strict simple-DOCX profile. It
accepts exactly ten named parts with fixed relationships, content types, root
namespaces, paragraph wrappers and section layout. Styles/theme/fontTable/settings
are fixed to the inspected template bytes, not learned from an input file.
The fixed paragraph wrapper may repeat from 1 to 256 times; each paragraph is a
single text run with the template formatting. Only bounded text values in those
paragraphs and supported metadata leaves may vary.
Unknown names, structural changes, unsupported markup and semantic settings are
rejected. Format data is preserved rather than reconstructed as unformatted text.
This is a non-WYSIWYG text operation contract, not a general native-editor adapter.

The template uses w:t without xml:space. Following independent review, the
profile rejects leading/trailing whitespace and repeated ASCII spaces on both
import and export instead of risking silent Office whitespace normalization.
XML-special characters are escaped; controls, malformed surrogate text and
accessor/iterator-based input arrays are rejected. ZIP data-descriptor entries
from the actual LO package are checked against central headers and exact offsets.

Actual editor/save experiment: authenticated HTTP approval, real PM text mutation,
PostgreSQL command journal and T06 local-object storage. The production profile
(not a test-only bypass) imports and exports the actual fixture. Normal commit
and lost-response reconciliation download the durable revision and compare its
bytes to the checked output, then reimport it. User editing after approval, lease
takeover and user editing during asynchronous serialization must prevent staging
or publishing a stale command snapshot. The retained applied-uncommitted state
in the serialization-race case is not called a successful save or auto-replayed.

Both downloaded successful revisions are reopened by the installed LibreOffice
and exported to text: Welcome world followed by Second paragraph. Headless
text conversion is not a visual/layout, GUI, accessibility or WPS verification.
Fontconfig reported unwritable-cache warnings, so no font rendering claim is made.

No product entry, default writer, routing change or automatic approval is added.
Different templates/versions or an ordinary Office re-save can change fixed parts
and be rejected. Broader compatibility needs new reviewed schemas and real-source
fixtures, not weakening unknown-part checks. No claim of full T14 completion.

## Final focused results

- 13 new profile tests + 16 original strict tests: 29/29.
- Real PostgreSQL/HTTP/PM/T06 production-profile flow: 5/5, zero skips; local
  object storage, no RustFS claim. Isolated PostgreSQL stopped after completion.
- Both final durable normal/lost-response DOCX files reopened to the expected
  two text paragraphs using the installed LibreOfficeDev.
- Focused strict TypeScript for profile and tests passed.
- Leading/trailing/repeated-space defect was reproduced RED before the fix;
  invalid metadata numeric shape and empty paragraphs were also made fail-closed.

Fixture SHA256:
`b9a88385928d849f75c3a2eebb1e4ddf4a56c55ac078c1e87c80f6e34f461ecb`.
Source input was `Hello world\nSecond paragraph\n`, converted with
`soffice --headless --convert-to 'docx:Office Open XML Text'` under an isolated
profile. Matching Application metadata is not a provenance/authenticity check.
Core revision, app TotalTime and AppVersion have bounded numeric formats; empty
paragraphs are unsupported. The current source template does not contain page or
word statistics; this profile does not calculate such statistics or render layout.
