#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE="${MESHDIRECT_SERVICE:-meshdirect-dev.service}"
HEALTH_URL="${MESHDIRECT_HEALTH_URL:-http://127.0.0.1:31841/qwen38/api/health}"
CURL="${CURL:-/usr/bin/curl}"
SYSTEMCTL="${SYSTEMCTL:-/usr/bin/systemctl}"

probe() {
  local body
  body="$($CURL --fail --silent --show-error --max-time 3 "$HEALTH_URL" 2>/dev/null)" || return 1
  [[ "$body" == *'"ok":true'* ]]
}

# Avoid restarting a healthy process because one packet briefly disappeared into
# the machinery. Humanity has enough watchdogs that panic at shadows already.
if $SYSTEMCTL is-active --quiet "$SERVICE" && probe; then
  exit 0
fi
sleep 5
if $SYSTEMCTL is-active --quiet "$SERVICE" && probe; then
  exit 0
fi

if $SYSTEMCTL is-active --quiet "$SERVICE"; then
  echo "meshdirect-healthguard: health failed twice; restarting $SERVICE"
  $SYSTEMCTL restart "$SERVICE"
else
  echo "meshdirect-healthguard: $SERVICE is inactive; starting it"
  $SYSTEMCTL start "$SERVICE"
fi

for _ in $(seq 1 30); do
  if $SYSTEMCTL is-active --quiet "$SERVICE" && probe; then
    echo "meshdirect-healthguard: recovery verified"
    exit 0
  fi
  sleep 0.5
done

echo "meshdirect-healthguard: recovery did not become healthy" >&2
exit 1
