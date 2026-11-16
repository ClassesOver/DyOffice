#!/usr/bin/env bash
set -euo pipefail
# Disposable GitHub runner only; local development uses dedicated provisioned services.
[[ ${GITHUB_ACTIONS:-} == true && $(id -u) == 0 ]] || { echo 'Disposable CI runner required' >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l
curl --proto '=https' --tlsv1.2 -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/keyrings/dyoffice-pgdg.asc
[[ $(gpg --show-keys --with-colons /usr/share/keyrings/dyoffice-pgdg.asc | awk -F: '$1=="fpr" {print $10; exit}') == B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8 ]] || { echo 'PGDG key mismatch' >&2; exit 1; }
printf '%s\n' 'deb [signed-by=/usr/share/keyrings/dyoffice-pgdg.asc] https://apt.postgresql.org/pub/repos/apt noble-pgdg main' > /etc/apt/sources.list.d/dyoffice-pgdg.list
apt-get update -qq
apt-get install -y --no-install-recommends 'postgresql-17=17.12-1.pgdg24.04+1' 'postgresql-client-17=17.12-1.pgdg24.04+1' 'redis-server=5:7.0.15-1ubuntu0.24.04.5' 'redis-tools=5:7.0.15-1ubuntu0.24.04.5' build-essential unzip
pg_createcluster 17 dyoffice --port=55432 --start
runuser -u postgres -- psql -p 55432 -v ON_ERROR_STOP=1 <<'SQL'
ALTER USER postgres PASSWORD 'dyoffice-ci-test-only';
CREATE DATABASE dyoffice_test;
SQL
systemd-run --quiet --unit=dyoffice-ci-redis --property=User=redis /usr/bin/redis-server --bind 127.0.0.1 --port 16379 --save '' --appendonly no
for attempt in {1..50}; do
  if redis-cli -p 16379 ping | grep -q PONG; then break; fi
  sleep .1
done
redis-cli -p 16379 ping | grep -q PONG
if [[ ${1:-} == --objectstore ]]; then
  curl --proto '=https' --tlsv1.2 -fL https://github.com/rustfs/rustfs/releases/download/1.0.6/rustfs-linux-x86_64-gnu-v1.0.6.zip -o /tmp/dyoffice-rustfs.zip
  printf '%s\n' '4f0bf3fecbe861467427ff506aee22c302cfd5ac8b7dcbde71714f8e5e680dea  /tmp/dyoffice-rustfs.zip' | sha256sum --check --strict
  unzip -p /tmp/dyoffice-rustfs.zip rustfs > /usr/local/bin/dyoffice-test-rustfs
  chmod 555 /usr/local/bin/dyoffice-test-rustfs
  useradd --system --no-create-home --shell /usr/sbin/nologin dyoffice-objectstore
  install -d -m 700 -o dyoffice-objectstore -g dyoffice-objectstore /var/lib/dyoffice-ci-objectstore /var/lib/dyoffice-ci-objectstore/data
  systemd-run --quiet --unit=dyoffice-ci-objectstore --property=User=dyoffice-objectstore --property=WorkingDirectory=/var/lib/dyoffice-ci-objectstore --property=MemoryMax=768M --property=Environment=RUSTFS_ACCESS_KEY=dyoffice-ci-s3-test --property=Environment=RUSTFS_SECRET_KEY=dyoffice-ci-s3-test-only-secret --property=Environment=RUSTFS_CONSOLE_ENABLE=false /usr/local/bin/dyoffice-test-rustfs server --address 127.0.0.1:19000 /var/lib/dyoffice-ci-objectstore/data
  for attempt in {1..100}; do
    if curl -fsS http://127.0.0.1:19000/health/ready; then exit 0; fi
    sleep .2
  done
  exit 1
fi
