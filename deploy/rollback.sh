#!/usr/bin/env bash
# Point "current" at a release that is still on the hub (atomic ln -sfn + mv -T), test and reload
# nginx in sog-web, then check that sog-web and the public site serve that release.
#   bash deploy/rollback.sh                    # list the releases on the hub, newest first (* = live)
#   bash deploy/rollback.sh <id>               # switch to release <id> (12 hex, from the list)
#   bash deploy/rollback.sh <id> --insecure-tls   # public check accepts the staging certificate
# A failed `nginx -t` or a failed check inside sog-web puts the release that was live back.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

ID=""
INSECURE=0
for a in "$@"; do
  case "$a" in
    --insecure-tls) INSECURE=1 ;;
    -h | --help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d'; exit 0 ;;
    *) [ -z "$ID" ] || die "one release id only"; ID="$a" ;;
  esac
done

load_hub_env "${SOG_HUB_ENV:-$HERE/hub.env}"
hub_setup

if [ -z "$ID" ]; then
  remote "$BASE" <<'REMOTE'
set -euo pipefail
cd "$1/releases" 2>/dev/null || { echo "no $1/releases on the hub"; exit 1; }
cur=$(readlink current 2>/dev/null || echo none)
for d in $(ls -1t | { grep -E '^[0-9a-f]{12}$' || true; }); do
  meta=$(tr -d ' \r\n\t' < "$d/release.json" 2>/dev/null || true)
  built=$(printf '%s' "$meta" | sed -n 's/.*"built":"\([^"]*\)".*/built \1/p')
  commit=$(printf '%s' "$meta" | sed -n 's/.*"commit":"\([^"]*\)".*/, commit \1/p')
  meta="$built$commit"
  mark=" "; [ "$d" = "$cur" ] && mark="*"
  echo "$mark $d  deployed $(date -u -r "$d" +%Y-%m-%dT%H:%MZ)  ${meta}"
done
echo "current -> $cur"
REMOTE
  exit 0
fi

[[ "$ID" =~ ^[0-9a-f]{12}$ ]] || die "a release id is 12 hex characters (see: bash deploy/rollback.sh)"

out=$(remote "$BASE" "$ID" "$VHOST" <<'REMOTE' | tee /dev/stderr
set -euo pipefail
BASE="$1"; ID="$2"; VHOST="$3"
cd "$BASE"
exec 9>>"$BASE/.deploy.lock"
flock -n 9 || { echo "REFUSED: another deploy or rollback holds $BASE/.deploy.lock"; exit 1; }
[ -d "releases/$ID" ] || { echo "REFUSED: no release $ID on the hub (bash deploy/rollback.sh lists them)"; exit 1; }
[ -f "releases/$ID/en/index.html" ] || { echo "REFUSED: releases/$ID has no en/index.html"; exit 1; }
prev=$(readlink releases/current 2>/dev/null || echo none)
[ "$prev" != "$ID" ] || { echo "release $ID is already live"; echo "SWITCHED=$ID"; exit 0; }
point() { ln -sfn "$1" releases/.current-new && mv -T releases/.current-new releases/current; }
web_running() { [ "$(docker inspect -f '{{.State.Running}}' sog-web 2>/dev/null || echo false)" = true ]; }
put_back() {
  if [ "$prev" != none ] && [ -d "releases/$prev" ]; then point "$prev"; fi
  if web_running && docker exec sog-web nginx -t >/dev/null 2>&1; then docker exec sog-web nginx -s reload >/dev/null 2>&1 || true; fi
  echo "PUT BACK: $1; current -> $(readlink releases/current 2>/dev/null || echo none)"
  exit 1
}
point "$ID"
touch "releases/$ID"
echo "current -> $ID (was $prev)"
web_running || { echo "sog-web is not running: switched without a check (it serves current when it starts)"; echo "SWITCHED=$ID"; exit 0; }
docker exec sog-web nginx -t >/dev/null 2>&1 || put_back "nginx -t failed in sog-web"
docker exec sog-web nginx -s reload >/dev/null 2>&1 || put_back "nginx -s reload failed in sog-web"
got=""
for _ in $(seq 1 20); do
  got=$(docker exec sog-web wget -q -O - --header "Host: $VHOST" "http://127.0.0.1/release.json?cb=$RANDOM" 2>/dev/null |
    tr -d ' \r\n\t' | sed -n 's/.*"sha":"\([0-9a-f]\{12\}\)".*/\1/p' || true)
  [ "$got" = "$ID" ] && break
  sleep 0.5
done
[ "$got" = "$ID" ] || put_back "sog-web serves release '${got:-none}', not $ID"
echo "sog-web: /release.json names $ID"
echo "SWITCHED=$ID"
REMOTE
) || die "rollback to $ID stopped on the hub (see above)"
[[ "$out" == *"SWITCHED=$ID"* ]] || die "rollback to $ID: no confirmation from the hub"

wait_public "$ID" || die "the hub serves $ID, but $PUBLIC_URL does not (yet): look at the site now"
say "DONE: release $ID is live at $PUBLIC_URL/en/"
