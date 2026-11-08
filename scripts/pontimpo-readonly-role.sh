#!/usr/bin/env bash
# Local stand-in for "a read-only role / read replica": the role the agent's
# analytics SQL (and the number→PK resolver) connects as when it runs against
# a local Pontimpo database instead of a deployed one.
#
#   AGENT_RO_PASSWORD=… scripts/pontimpo-readonly-role.sh <database> [role]
#
# Idempotent. Installs this repo's rpc-function.sql (SECURITY INVOKER) if
# absent, creates/updates the LOGIN role, grants CONNECT + USAGE + SELECT and
# EXECUTE on execute_readonly_sql only, and withholds the auth/secret tables.
# The password is read from the environment and never printed.
set -euo pipefail

D0="$(cd "$(dirname "$0")/.." && pwd)"
DB="${1:?usage: $0 <database> [role]}"
ROLE="${2:-pontimpo_agent_ro}"
: "${AGENT_RO_PASSWORD:?set AGENT_RO_PASSWORD (kept only in a gitignored env file)}"

psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$D0/rpc-function.sql" >/dev/null

psql -q -v ON_ERROR_STOP=1 -d "$DB" -v role="$ROLE" -v pw="$AGENT_RO_PASSWORD" -v db="$DB" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN', :'role')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role') \gexec
SELECT format('ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'role', :'pw') \gexec
-- Belt and braces: every session of this role starts read-only.
SELECT format('ALTER ROLE %I SET default_transaction_read_only = on', :'role') \gexec

SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'db', :'role') \gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'role') \gexec
SELECT format('GRANT SELECT ON ALL TABLES IN SCHEMA public TO %I', :'role') \gexec
-- Analytics never needs credentials, sessions or password hashes.
SELECT format('REVOKE ALL ON TABLE auth_account, auth_session, auth_verification, auth_rate_limit, api_credential, idempotency_key FROM %I', :'role') \gexec

REVOKE ALL ON FUNCTION execute_readonly_sql(text) FROM PUBLIC;
SELECT format('GRANT EXECUTE ON FUNCTION execute_readonly_sql(text) TO %I', :'role') \gexec
SQL

echo "read-only role $ROLE ready on $DB (password not shown)"
