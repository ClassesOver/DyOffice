#!/bin/sh
set -eu
[ "$#" -eq 0 ] || { echo 'UNSUPPORTED: diagnostic accepts no arguments' >&2; exit 78; }
cd /opt/dyoffice-diagnostic
sha256sum -c probe.sha256 >/dev/null || { echo 'UNSUPPORTED: diagnostic binary integrity mismatch' >&2; exit 78; }
# Ignore caller-supplied bus addresses, credentials and commands. In-container only.
exec env -i PATH=/usr/bin:/bin LANG=C DYOFFICE_CONTAINER_PROBE=ubuntu-docker-benign-only \
  ./probe systemd_driver::container_diagnostic::fixed_sleep_unit_times_out --exact --ignored --nocapture
