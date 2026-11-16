#!/bin/bash
# Manual, disposable QA only. Never mount this in the production app.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
: "${DYOFFICE_TEST_DATABASE_URL:?Provide an isolated loopback dyoffice_test PostgreSQL connection}"
: "${DYOFFICE_TEST_S3_ENDPOINT:?Provide a disposable loopback S3 service}"
: "${DYOFFICE_TEST_S3_ACCESS_KEY:?Provide disposable S3 credentials}"
: "${DYOFFICE_TEST_S3_SECRET_KEY:?Provide disposable S3 credentials}"
export NODE_OPTIONS=${NODE_OPTIONS:---max-old-space-size=384}
cd "$ROOT"
node apps/web/tools/build-command-recovery-ui.mjs
# Generated control files from an earlier manual session must not affect a new run.
rm -f qa-recovery/stop qa-recovery/mode
node --import tsx qa-recovery/server.mjs
