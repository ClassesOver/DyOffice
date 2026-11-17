#!/bin/sh
set -eu
case "${1:-web}" in
  web)
    if [ -f /run/secrets/config_keyring ]; then
      export DYOFFICE_CONFIG_KEYRING="$(cat /run/secrets/config_keyring)"
    fi
    export DYOFFICE_AUTH_DATABASE_URL="postgresql://dyoffice_auth:$(cat /run/secrets/auth_password)@db:5432/dyoffice"
    export DYOFFICE_BUSINESS_DATABASE_URL="postgresql://dyoffice_business:$(cat /run/secrets/business_password)@db:5432/dyoffice"
    export DYOFFICE_CSRF_KEY="$(cat /run/secrets/csrf_key)"
    exec node --import tsx apps/web/server/index.mjs ;;
  provision|admin)
    export DYOFFICE_DATABASE_URL="postgresql://dyoffice_owner:$(cat /run/secrets/owner_password)@db:5432/dyoffice"
    export DYOFFICE_AUTH_ROLE=dyoffice_auth DYOFFICE_BUSINESS_ROLE=dyoffice_business
    if [ "$1" = provision ]; then
      exec node --experimental-strip-types tools/dyoffice/provision-runtime.ts
    fi
    exec node --experimental-strip-types tools/dyoffice/bootstrap-admin.ts ;;
  *) echo 'Expected web, provision or admin' >&2; exit 2 ;;
esac
