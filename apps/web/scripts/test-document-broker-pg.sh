#!/usr/bin/env bash
# Explicit integration recipe. Never run against production databases.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
MODE=${1:-}
case "$MODE" in ledger|tls) ;; *) echo 'Usage: test-document-broker-pg.sh ledger|tls' >&2; exit 2;; esac
TMP=$(mktemp -d)
cleanup() {
 if [[ $MODE == tls && -n ${PG_BIN:-} ]]; then
  "$PG_BIN/pg_ctl" -D "$TMP/data" stop >/dev/null 2>&1 || true
  "$PG_BIN/pg_ctl" -D "$TMP/plain" stop >/dev/null 2>&1 || true
 fi
 rm -rf "$TMP"
}
trap cleanup EXIT
cargo test --locked --manifest-path "$ROOT/services/document-broker/Cargo.toml" --lib --no-run --message-format=json > "$TMP/build.json"
export RUST_PG_TEST_BINARY
RUST_PG_TEST_BINARY=$(node --input-type=module - "$TMP/build.json" <<'JS'
import {readFileSync} from 'node:fs';
const artifacts=readFileSync(process.argv[2],'utf8').trim().split('\n').map(s=>JSON.parse(s)).filter(x=>x.reason==='compiler-artifact'&&x.profile?.test&&x.executable);
if(artifacts.length!==1)throw Error('Expected exactly one library test executable');
console.log(artifacts[0].executable);
JS
)
if [[ $MODE == ledger ]]; then
 : "${DYOFFICE_TEST_DATABASE_URL:?Set an isolated disposable test database URL}"
 node --experimental-strip-types --test --test-concurrency=1 "$ROOT/apps/web/test/sandbox-pg/rust-consumer.test.mjs"
else
 : "${PG_BIN:?Set directory containing initdb and pg_ctl}"
 export TLS_TEST_PORT=${TLS_TEST_PORT:-55448} TLS_PLAIN_PORT=${TLS_PLAIN_PORT:-55449}
 [[ $TLS_TEST_PORT =~ ^[0-9]+$ && $TLS_PLAIN_PORT =~ ^[0-9]+$ ]] || exit 2
 openssl req -x509 -newkey rsa:2048 -nodes -keyout "$TMP/server.key" -out "$TMP/server.crt" -days 1 -subj /CN=localhost -addext 'subjectAltName=DNS:localhost' >/dev/null 2>&1
 openssl req -x509 -newkey rsa:2048 -nodes -keyout "$TMP/wrong.key" -out "$TMP/wrong.crt" -days 1 -subj /CN=untrusted-test >/dev/null 2>&1
 "$PG_BIN/initdb" -D "$TMP/data" -U testadmin -A trust --no-locale >/dev/null
 "$PG_BIN/initdb" -D "$TMP/plain" -U testadmin -A trust --no-locale >/dev/null
 "$PG_BIN/pg_ctl" -D "$TMP/data" -l "$TMP/tls.log" -o "-h 127.0.0.1 -p $TLS_TEST_PORT -c unix_socket_directories='' -c ssl=on -c ssl_cert_file=$TMP/server.crt -c ssl_key_file=$TMP/server.key" start
 "$PG_BIN/pg_ctl" -D "$TMP/plain" -l "$TMP/plain.log" -o "-h 127.0.0.1 -p $TLS_PLAIN_PORT -c unix_socket_directories=''" start
 export TLS_TEST_CA="$TMP/server.crt" TLS_TEST_WRONG_CA="$TMP/wrong.crt"
 node --test "$ROOT/apps/web/test/sandbox-pg/rust-tls.test.mjs"
 export RUST_PG_TEST_CA="$TMP/server.crt" RUST_PG_TEST_KEY="$TMP/server.key"
 export DYOFFICE_TEST_DATABASE_URL="postgresql://testadmin@127.0.0.1:$TLS_TEST_PORT/postgres"
 node --experimental-transform-types --test --test-concurrency=1 "$ROOT/apps/web/test/sandbox-pg/rust-consumer.test.mjs"
fi
