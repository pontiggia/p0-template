#!/usr/bin/env bash
# Hermetic Pontimpo app for the agent's tests: a fresh pontimpo_e2e_s6
# database (migrated + seeded), a production build served on :3091, and three
# scoped credentials minted through the app's own service into .env.test.local.
#
#   pnpm pontimpo:up     # create DB, migrate, seed, build, start, mint
#   pnpm pontimpo:down   # stop the server, drop the DB, delete .env.test.local
#
# Never touches pontimpo_dev / pontimpo_etl, never edits the pontimpo repo
# (only its gitignored .next build output).
set -euo pipefail

D0="$(cd "$(dirname "$0")/.." && pwd)"
PONTIMPO="${PONTIMPO_DIR:-$D0/../pontimpo-tire-system}"
DB="${PONTIMPO_TEST_DB:-pontimpo_e2e_s6}"
PORT="${PONTIMPO_TEST_PORT:-3091}"
DB_URL="postgres://localhost:5432/$DB"
APP_URL="http://localhost:$PORT"
ENV_OUT="$D0/.env.test.local"
PID_FILE="$D0/.pontimpo-test-app.pid"
LOG_FILE="$D0/.pontimpo-test-app.log"

case "$DB" in pontimpo_e2e*) ;; *) echo "refusing non-e2e database: $DB" >&2; exit 1 ;; esac

down() {
  if [[ -f "$PID_FILE" ]]; then
    # pnpm start → next start → next-server: kill the whole process group.
    kill -- -"$(cat "$PID_FILE")" 2>/dev/null || kill "$(cat "$PID_FILE")" 2>/dev/null || true
    rm -f "$PID_FILE"
  fi
  dropdb --if-exists --force "$DB"
  rm -f "$ENV_OUT" "$LOG_FILE"
  echo "pontimpo test app down ($DB dropped)"
}

up() {
  if lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $PORT is already in use — run pnpm pontimpo:down first" >&2; exit 1
  fi
  dropdb --if-exists --force "$DB"
  createdb "$DB"
  cd "$PONTIMPO"
  # DATABASE_URL in the environment beats .env.local (dotenv / @next/env never
  # override), so migrate, seed, build-time prerender and the server all use $DB.
  export DATABASE_URL="$DB_URL" BETTER_AUTH_URL="$APP_URL"
  pnpm db:migrate >/dev/null
  pnpm db:seed >/dev/null
  # The analytics gateway (d0's own rpc-function.sql), so executeSQL runs for real.
  psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$D0/rpc-function.sql" >/dev/null
  pnpm build >/dev/null
  set -m # own process group, so `down` can stop pnpm + next-server together
  nohup pnpm start -p "$PORT" >"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  set +m
  for _ in $(seq 1 60); do
    curl -sf -o /dev/null "$APP_URL/login" && break
    sleep 1
  done
  curl -sf -o /dev/null "$APP_URL/login" || { echo "app did not come up; see $LOG_FILE" >&2; exit 1; }
  pnpm exec tsx "$D0/scripts/mint-pontimpo-credentials.mts" "$ENV_OUT" "$APP_URL"
  echo "pontimpo test app up at $APP_URL on $DB"
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  *) echo "usage: $0 up|down" >&2; exit 2 ;;
esac
