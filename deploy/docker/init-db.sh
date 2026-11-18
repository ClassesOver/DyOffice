#!/bin/sh
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v owner_password="$(cat /run/secrets/owner_password)" \
  -v auth_password="$(cat /run/secrets/auth_password)" \
  -v business_password="$(cat /run/secrets/business_password)" <<'SQL'
CREATE ROLE dyoffice_owner LOGIN PASSWORD :'owner_password' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
CREATE ROLE dyoffice_auth LOGIN PASSWORD :'auth_password' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
CREATE ROLE dyoffice_business LOGIN PASSWORD :'business_password' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
CREATE DATABASE dyoffice OWNER dyoffice_owner;
REVOKE ALL ON DATABASE dyoffice FROM PUBLIC;
GRANT CONNECT ON DATABASE dyoffice TO dyoffice_owner, dyoffice_auth, dyoffice_business;
SQL
