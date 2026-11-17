#!/bin/bash
set -eu
cd "$(dirname "$0")/.."
: "${DYOFFICE_TEST_DATABASE_URL:?Provide disposable dyoffice_test DB connection}"
rm -f qa-controlled/stop
node --import tsx qa-controlled/server.mjs > qa-controlled/gui.log 2>&1
