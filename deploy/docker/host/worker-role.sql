-- Run against the dedicated DB as its DBA, providing psql variable worker_password
-- from a protected local file/input, NOT a password literal committed here.
CREATE ROLE dyoffice_worker LOGIN PASSWORD :'worker_password'
 NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
GRANT CONNECT ON DATABASE dyoffice TO dyoffice_worker;
-- Then run provision-runtime.ts with the migration owner and
-- DYOFFICE_AUTH_ROLE=dyoffice_auth DYOFFICE_BUSINESS_ROLE=dyoffice_business
-- DYOFFICE_WORKER_ROLE=dyoffice_worker. Do not give owner credentials to services.
