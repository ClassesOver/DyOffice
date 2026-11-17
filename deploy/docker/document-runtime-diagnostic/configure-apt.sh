#!/bin/sh
set -eu
[ "$#" -eq 2 ] || exit 78
# Validate complete, single-line values before any system inspection or mutation.
sh /opt/validate-inputs.sh "$1" "$2"
. /etc/os-release
[ "$ID" = ubuntu ] && [ "$VERSION_ID" = 24.04 ] || exit 78
[ "$(dpkg --print-architecture)" = amd64 ] || exit 78
[ -f /usr/share/keyrings/ubuntu-archive-keyring.gpg ] || exit 78
# Only build-image apt config changes; never touch the host daemon or its sources.
rm -f /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources
printf 'Types: deb
URIs: %s
Suites: noble noble-updates noble-security
Components: main universe
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
' "$2" > /etc/apt/sources.list.d/ubuntu.sources
