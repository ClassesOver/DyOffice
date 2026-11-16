#!/bin/bash
# Manual, disposable QA only. The fixture rejects non-test database names.
set -eu
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
: "${DYOFFICE_TEST_DATABASE_URL:?Provide an isolated dyoffice_test PostgreSQL connection}"
export NODE_OPTIONS=${NODE_OPTIONS:---max-old-space-size=384}
cd "$ROOT"
rm -f qa-recovery/stop
node --import tsx qa-recovery/server.mjs > qa-recovery/gui.log 2>&1
