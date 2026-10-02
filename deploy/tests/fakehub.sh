#!/usr/bin/env bash
# End-to-end test of deploy.sh, rollback.sh and hub.sh against a FAKE hub on this machine.
#   bash deploy/tests/fakehub.sh
# Needs Docker, curl and network access once (apk add in the fake hub image). Never contacts the
# real hub: `ssh` is replaced (PATH) by a script that runs the command in a local container.
#
# The fake hub is one container from nginx:1.29-alpine (+ bash, GNU coreutils/tar, python3):
#   - it IS sog-web: its nginx reads /srv/hub/sog/nginx.conf and serves /srv/hub/sog/releases,
#     published on 127.0.0.1:$PORT, which stands in for https://sog.flyreelstudio.eu
#   - `docker` inside it is a stub (docker-stub below): exec/inspect/restart/run for sog-web act on
#     this container's own nginx; `docker run ... nginx -t` tests a config with the same nginx
# A second container (alias sog-api on the same network) answers /api/health for the API checks.
set -euo pipefail
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY="$(cd "$HERE/.." && pwd)"
NET=sog-fakehub-net
HUBC=sog-fakehub
APIC=sog-fakehub-api
IMG=sog-fakehub:test
PORT="${SOG_TEST_PORT:-18081}"
URL="http://127.0.0.1:$PORT"
WORK="$(mktemp -d)"

cleanup() {
  docker rm -f "$HUBC" "$APIC" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
cleanup_keep_work() { docker rm -f "$HUBC" "$APIC" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
cleanup_keep_work
trap cleanup EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$*"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n' "$*"; }
expect() { if [ "$2" = "$3" ]; then ok "$1: $2"; else bad "$1: got '$2', want '$3'"; fi; }
has() { if [[ "$2" == *"$3"* ]]; then ok "$1"; else bad "$1: '$3' not in output"; printf '%s\n' "$2" | tail -n 15 | sed 's/^/      | /'; fi; }
on_hub() { docker exec -i "$HUBC" bash -c "$1" || true; }
live_id() { curl -s "$URL/release.json" | sed -n 's/.*"sha":"\([0-9a-f]\{12\}\)".*/\1/p'; }
hub_current() { on_hub 'readlink /srv/hub/sog/releases/current || echo none'; }
# run SCRIPT ARGS...: run a deploy script against the fake hub, capture output and exit code
run() {
  local script="$1"
  shift
  set +e
  OUT=$(PATH="$WORK/bin:$PATH" SOG_HUB_ENV="${HUBENV:-$WORK/hub.env}" bash "$script" "$@" 2>&1)
  RC=$?
  set -e
  printf '%s\n' "$OUT" | sed 's/^/      | /'
}

echo "== build the fake hub image"
mkdir -p "$WORK/image" "$WORK/bin"
cat > "$WORK/image/docker-stub" <<'STUB'
#!/bin/bash
# fake `docker` on the fake hub: sog-web is this container's own nginx
set -euo pipefail
echo "docker $*" >> /tmp/docker-calls.log
running() { [ ! -f /tmp/web-stopped ] && [ -s /run/nginx.pid ] && kill -0 "$(cat /run/nginx.pid)" 2>/dev/null; }
case "${1:-}" in
  inspect)
    shift
    fmt=""
    if [ "${1:-}" = -f ]; then fmt="$2"; shift 2; fi
    case "$1" in
      sog-web)
        case "$fmt" in
          *State.Running*) if running; then echo true; else echo false; fi ;;
          *Config.Image*) echo nginx:1.29-alpine ;;
          *) echo '[{}]' ;;
        esac ;;
      sog-api)
        [ -f /tmp/containers ] || { echo "Error: No such object: sog-api" >&2; exit 1; }
        case "$fmt" in *Config.Image*) echo fake-python ;; *) echo '[{}]' ;; esac ;;
      *) echo "Error: No such object: $1" >&2; exit 1 ;;
    esac ;;
  exec)
    shift
    while [[ "${1:-}" == -* ]]; do shift; done
    name="$1"; shift
    [ "$name" = sog-web ] || { echo "stub: exec only into sog-web" >&2; exit 1; }
    # test hook: sog-web serving a stale release.json
    if [ -f /tmp/stale-release-json ] && [ "$1" = wget ] && [[ "$*" == *release.json* ]]; then
      echo '{"sha":"000000000000"}'; exit 0
    fi
    exec "$@" ;;
  restart)
    case "$2" in
      sog-web) nginx -s stop 2>/dev/null || true; sleep 0.5; nginx; echo sog-web ;;
      sog-api) echo sog-api ;;
      *) exit 1 ;;
    esac ;;
  run)
    shift
    conf=""; app=""; entry=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --rm) shift ;;
        --network) shift 2 ;;
        -v) src="${2%%:*}"; rest="${2#*:}"; dst="${rest%%:*}"; shift 2
            [ "$dst" = /etc/nginx/conf.d/default.conf ] && conf="$src"
            [ "$dst" = /app ] && app="$src" ;;
        --entrypoint) entry="$2"; shift 2 ;;
        *) break ;;
      esac
    done
    shift   # image
    if [ "$entry" = nginx ]; then
      sed -e "s#include /etc/nginx/conf.d/\*.conf;#include $conf;#" -e 's#^pid .*#pid /tmp/nginx-test.pid;#' /etc/nginx/nginx.conf > /tmp/nginx-test-main.conf
      exec nginx -c /tmp/nginx-test-main.conf "$@"
    elif [ "$entry" = python ]; then
      ln -sfn "$app" /app
      exec python3 "$@"
    fi
    echo "stub: unsupported docker run" >&2; exit 1 ;;
  ps) [ -f /tmp/containers ] && cat /tmp/containers; exit 0 ;;
  network) [ "${2:-}" = inspect ] && [ "${3:-}" = web-proxy ] && exit 0; exit 1 ;;
  *) echo "stub: unsupported: docker $*" >&2; exit 1 ;;
esac
STUB
cat > "$WORK/image/Dockerfile" <<'EOF'
FROM nginx:1.29-alpine
RUN apk add --no-cache bash coreutils tar diffutils python3 >/dev/null
COPY docker-stub /usr/local/bin/docker
RUN chmod 755 /usr/local/bin/docker
EOF
docker build -q -t "$IMG" "$(cygpath -m "$WORK/image" 2>/dev/null || echo "$WORK/image")" >/dev/null
docker network create "$NET" >/dev/null
docker run -d --name "$HUBC" --network "$NET" -p "127.0.0.1:$PORT:80" "$IMG" sh -c '
  mkdir -p /srv/hub/other
  rm -f /etc/nginx/conf.d/default.conf
  ln -s /srv/hub/sog/nginx.conf /etc/nginx/conf.d/default.conf
  ln -s /srv/hub/sog/releases /srv/releases
  exec sleep infinity' >/dev/null
docker run -d --name "$APIC" --network "$NET" --network-alias sog-api python:3.12-alpine python -u -c '
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.send_header("Content-Length", "11"); self.end_headers(); self.wfile.write(b"{\"ok\":true}")
    def log_message(self, *a):
        pass
ThreadingHTTPServer(("0.0.0.0", 8090), H).serve_forever()' >/dev/null
# an existing service's config.env holding the Telegram lines and one more secret
on_hub 'printf "OTHER_SECRET=zzz\nTG_BOT_TOKEN=123:abc\nTG_CHAT_ID=-100\n" > /srv/hub/other/config.env'

# fake ssh: drop options and destination, run the command line in the fake hub
cat > "$WORK/bin/ssh" <<'EOF'
#!/usr/bin/env bash
while [ $# -gt 0 ]; do
  case "$1" in
    -p | -i | -o | -l) shift 2 ;;
    -*) shift ;;
    *) break ;;
  esac
done
shift
[ $# -gt 0 ] || exec docker exec -it sog-fakehub bash
exec docker exec -i sog-fakehub bash -c "$*"
EOF
chmod +x "$WORK/bin/ssh"

cat > "$WORK/hub.env" <<EOF
# fake hub for deploy/tests/fakehub.sh
SOG_HOST=fake@fakehub
SOG_PORT=22
SOG_KEY=~/.ssh/id_fake
SOG_BASE=/srv/hub/sog
SOG_BACKUPS="/srv/hub/_backups"
SOG_TG_CONFIG_SRC=/srv/hub/other/config.env
SOG_PUBLIC_URL=$URL
SOG_KEEP_RELEASES=3
SOG_KEEP_BACKUPS=2
EOF
sed "s#^SOG_PUBLIC_URL=.*#SOG_PUBLIC_URL=http://127.0.0.1:1#" "$WORK/hub.env" > "$WORK/hub-deadpublic.env"

# fake builds and API
# mkdist N [SHA]: a fake `npm run build` output; with SHA, a release.json as post-build.mjs writes it
mkdist() {
  local d="$WORK/dist$1"
  mkdir -p "$d/en" "$d/es" "$d/pl" "$d/ru" "$d/assets" "$d/.cache"
  for l in en es pl ru; do echo "<!doctype html><title>$l build $1</title>" > "$d/$l/index.html"; done
  echo "console.log($1)" > "$d/assets/app-$1.js"
  echo "junk" > "$d/.cache/x"
  if [ -n "${2:-}" ]; then echo "{\"sha\":\"$2\",\"built\":\"2026-10-02T10:00:00.000Z\"}" > "$d/release.json"; fi
}
mkdist 1                      # no release.json: deploy.sh computes the id
mkdist 2 2222aaaa2222         # the build named itself 2222aaaa2222
for i in 3 4 5 6; do mkdist "$i"; done
mkdist 7 2222aaaa2222         # a stale release.json: same sha, different content
mkdir -p "$WORK/api/tests" "$WORK/api/__pycache__"
echo 'print("api v1")' > "$WORK/api/server.py"
echo 'x = 1' > "$WORK/api/tests/test_x.py"
echo 'junk' > "$WORK/api/__pycache__/server.cpython-312.pyc"

D="$DEPLOY/deploy.sh"
R="$DEPLOY/rollback.sh"

echo "== 1. --check before --init: refused"
run "$D" --check --dist "$WORK/dist1"
expect "exit code" "$RC" 1
has "says to run --init" "$OUT" "run 'bash deploy/deploy.sh --init' first"

echo "== 2. --init"
run "$D" --init --api-dir "$WORK/api"
expect "exit code" "$RC" 0
has "installs files" "$OUT" "installed: compose.yml compose.staging.yml nginx.conf api/ (1 files)"
has "reports the missing config.env" "$OUT" "config.env: MISSING"
expect "nginx.conf on the hub = repo" "$(on_hub 'sha256sum /srv/hub/sog/nginx.conf' | cut -c1-64)" "$(sha256sum "$DEPLOY/nginx.conf" | cut -c1-64)"
expect "api/ without tests and caches" "$(on_hub 'cd /srv/hub/sog/api && find . -type f | sort | tr "\n" " "')" "./server.py "
expect "no secret leaked into the output" "$(printf '%s' "$OUT" | grep -c '123:abc' || true)" 0
INIT_OUT="$OUT"

echo "== 3. the printed config.env command, run through hub.sh"
cmd=$(printf '%s\n' "$OUT" | grep -A1 'On the hub:' | tail -n 1 | sed 's/^ *//')
echo "      command: $cmd"
run "$DEPLOY/hub.sh" "$cmd"
expect "it prints only the line count" "$OUT" "2"
expect "config.env holds only the two Telegram lines" "$(on_hub 'cut -d= -f1 /srv/hub/sog/config.env | tr "\n" " "')" "TG_BOT_TOKEN TG_CHAT_ID "
expect "config.env mode" "$(on_hub 'stat -c %a /srv/hub/sog/config.env')" "600"
line=$(printf '%s
' "$INIT_OUT" | grep -A1 'or from this machine:' | tail -n 1 | sed 's/^ *//')
echo "      printed line: $line"
on_hub 'rm -f /srv/hub/sog/config.env'
set +e
OUT=$(cd "$DEPLOY/.." && PATH="$WORK/bin:$PATH" SOG_HUB_ENV="$WORK/hub.env" eval "$line" 2>&1)
set -e
expect "the printed 'from this machine' line works as printed" "$OUT" "2"
expect "config.env again holds only the two Telegram lines" "$(on_hub 'cut -d= -f1 /srv/hub/sog/config.env | tr "
" " "')" "TG_BOT_TOKEN TG_CHAT_ID "
run "$DEPLOY/hub.sh" 'echo "BASE=$BASE BACKUPS=$BACKUPS"'
expect "hub.sh passes BASE and BACKUPS" "$OUT" "BASE=/srv/hub/sog BACKUPS=/srv/hub/_backups"

echo "== 4. 'docker compose up': start sog-web; a second --init is refused"
on_hub 'nginx && printf "sog-web\nsog-api\n" > /tmp/containers'
expect "/healthz" "$(curl -s "$URL/healthz")" "ok"
run "$D" --init --api-dir "$WORK/api"
expect "second --init exit code" "$RC" 1
has "second --init refused" "$OUT" "REFUSED: sog-web or sog-api already exists"

echo "== 5. first deploy"
run "$D" --dist "$WORK/dist1"
expect "exit code" "$RC" 0
ID1=$(printf '%s\n' "$OUT" | sed -n 's/^artifact: release \([0-9a-f]\{12\}\).*/\1/p')
has "no previous release" "$OUT" "PREV=none"
has "backup written" "$OUT" "backup /srv/hub/_backups/sog-predeploy-"
has "internal check" "$OUT" "sog-web: /release.json names $ID1, /en/ 200 with the CSP header"
has "public check" "$OUT" "public check: $URL/release.json = $ID1, /en/ = 200"
expect "live release" "$(live_id)" "$ID1"
expect "dotfiles not shipped" "$(on_hub "ls -A /srv/hub/sog/releases/$ID1 | grep -c '^\\.' || true")" 0
has "release.json written by deploy.sh (no release.json in the build)" "$(curl -s "$URL/release.json")" "\"sha\":\"$ID1\",\"built\":"
has "the id came from deploy.sh's content hash" "$OUT" "content hash by deploy.sh"
expect "uploads removed from incoming/" "$(on_hub 'ls -A /srv/hub/sog/incoming | wc -l')" 0
expect "release files are world-readable" "$(on_hub "find /srv/hub/sog/releases/$ID1 ! -perm -o+r | wc -l")" 0

echo "== 6. the same build again: same id, not unpacked again"
run "$D" --dist "$WORK/dist1"
expect "exit code" "$RC" 0
has "same id" "$OUT" "artifact: release $ID1"
has "kept, not unpacked again" "$OUT" "release $ID1 is already on the hub with the same content: kept"

echo "== 7. second deploy"
run "$D" --dist "$WORK/dist2"
expect "exit code" "$RC" 0
ID2=$(printf '%s\n' "$OUT" | sed -n 's/^artifact: release \([0-9a-f]\{12\}\).*/\1/p')
has "previous is ID1" "$OUT" "PREV=$ID1"
expect "the id is the build's own sha" "$ID2" "2222aaaa2222"
has "the id came from the build" "$OUT" "the build's release.json"
expect "live release" "$(live_id)" "$ID2"
expect "the build's release.json is served as built" "$(curl -s "$URL/release.json")" '{"sha":"2222aaaa2222","built":"2026-10-02T10:00:00.000Z"}'
bk=$(on_hub 'ls -1t /srv/hub/_backups/sog-predeploy-*.tgz | head -n 1')
lst=$(on_hub "tar -tzf $bk")
has "backup holds config.env" "$lst" "config.env"
has "backup holds nginx.conf" "$lst" "nginx.conf"
has "backup holds api/server.py" "$lst" "api/server.py"
has "backup holds the live symlink" "$lst" "releases/current"
has "backup holds the release that was live" "$lst" "releases/$ID1/en/index.html"
expect "backup mode (config.env inside)" "$(on_hub "stat -c %a $bk")" "600"

echo "== 7b. a stale release.json (same sha, different content): refused before any change"
run "$D" --dist "$WORK/dist7"
expect "exit code" "$RC" 1
has "refused" "$OUT" "REFUSED: releases/2222aaaa2222 already exists with DIFFERENT content"
expect "live release" "$(live_id)" "$ID2"
has "the live page is still build 2" "$(curl -s "$URL/en/")" "build 2"

echo "== 8. guard: the hub's nginx.conf differs from the repo -> refused before any upload"
on_hub 'echo "# edited on the hub" >> /srv/hub/sog/nginx.conf'
run "$D" --dist "$WORK/dist3"
expect "exit code" "$RC" 1
has "refused" "$OUT" "REFUSED: /srv/hub/sog/nginx.conf on the hub"
expect "nothing uploaded" "$(on_hub 'ls -A /srv/hub/sog/incoming | wc -l')" 0
expect "still live" "$(live_id)" "$ID2"

echo "== 9. --sync-config puts the repo's nginx.conf live, then deploys"
run "$D" --dist "$WORK/dist3" --sync-config
expect "exit code" "$RC" 0
ID3=$(printf '%s\n' "$OUT" | sed -n 's/^artifact: release \([0-9a-f]\{12\}\).*/\1/p')
has "config written in place and reloaded" "$OUT" "nginx.conf: written in place, tested in sog-web, reloaded"
expect "hub nginx.conf = repo" "$(on_hub 'sha256sum /srv/hub/sog/nginx.conf' | cut -c1-64)" "$(sha256sum "$DEPLOY/nginx.conf" | cut -c1-64)"
has "previous config kept" "$(on_hub 'tail -n 1 /srv/hub/sog/nginx.conf.prev')" "# edited on the hub"
expect "live release" "$(live_id)" "$ID3"

echo "== 10. --sync-config with a BROKEN nginx.conf: refused, nothing changed"
cp -R "$DEPLOY" "$WORK/deploy-broken"
echo "this is not nginx syntax" >> "$WORK/deploy-broken/nginx.conf"
run "$WORK/deploy-broken/deploy.sh" --dist "$WORK/dist4" --sync-config
expect "exit code" "$RC" 1
has "refused by nginx -t" "$OUT" "REFUSED: the new nginx.conf fails nginx -t"
expect "hub nginx.conf unchanged" "$(on_hub 'sha256sum /srv/hub/sog/nginx.conf' | cut -c1-64)" "$(sha256sum "$DEPLOY/nginx.conf" | cut -c1-64)"
expect "still live" "$(live_id)" "$ID3"
expect "/healthz" "$(curl -s "$URL/healthz")" "ok"

echo "== 11. internal check fails after the switch -> previous release put back"
on_hub 'touch /tmp/stale-release-json'
run "$D" --dist "$WORK/dist4"
on_hub 'rm -f /tmp/stale-release-json'
expect "exit code" "$RC" 1
has "rolled back on the hub" "$OUT" "ROLLED BACK: sog-web serves release '000000000000'"
expect "hub current" "$(hub_current)" "$ID3"
expect "live release" "$(live_id)" "$ID3"

echo "== 12. public check fails -> previous release put back from this machine"
HUBENV="$WORK/hub-deadpublic.env" run "$D" --dist "$WORK/dist5"
expect "exit code" "$RC" 1
ID5=$(printf '%s\n' "$OUT" | sed -n 's/^artifact: release \([0-9a-f]\{12\}\).*/\1/p')
has "switched on the hub first" "$OUT" "SWITCHED=$ID5"
has "public check failed" "$OUT" "public check FAILED"
has "previous put back" "$OUT" "ROLLED BACK: current -> $ID3"
expect "live release" "$(live_id)" "$ID3"

echo "== 13. a second deploy while one holds the lock: refused"
docker exec -d "$HUBC" flock /srv/hub/sog/.deploy.lock sleep 20
sleep 1
run "$D" --dist "$WORK/dist6"
expect "exit code" "$RC" 1
has "lock refusal" "$OUT" "REFUSED: another deploy or rollback holds /srv/hub/sog/.deploy.lock"
expect "live release" "$(live_id)" "$ID3"
on_hub 'pkill -f "sleep 20" || true'
sleep 1

echo "== 14. deploy dist6 (pruning: keep 3 releases, 2 backups)"
run "$D" --dist "$WORK/dist6"
expect "exit code" "$RC" 0
ID6=$(printf '%s\n' "$OUT" | sed -n 's/^artifact: release \([0-9a-f]\{12\}\).*/\1/p')
expect "live release" "$(live_id)" "$ID6"
expect "releases kept (the 3 newest + the previous live one)" "$(on_hub 'ls /srv/hub/sog/releases | grep -cE "^[0-9a-f]{12}$"')" 4
expect "backups kept" "$(on_hub 'ls /srv/hub/_backups | grep -c "^sog-predeploy-"')" 2
expect "the previous release survives pruning" "$(on_hub "test -d /srv/hub/sog/releases/$ID3 && echo yes")" yes

echo "== 15. rollback.sh"
run "$R"
expect "list exit code" "$RC" 0
has "list marks the live release" "$OUT" "* $ID6"
has "list shows current" "$OUT" "current -> $ID6"
run "$R" "$ID3"
expect "rollback exit code" "$RC" 0
has "rollback done" "$OUT" "DONE: release $ID3 is live"
expect "live release" "$(live_id)" "$ID3"
run "$R" "$ID3"
has "already live" "$OUT" "release $ID3 is already live"
run "$R" 0123456789ab
expect "unknown id exit code" "$RC" 1
has "unknown id refused" "$OUT" "REFUSED: no release 0123456789ab"
run "$R" "not-an-id"
expect "malformed id exit code" "$RC" 1
run "$R" "$ID6"
expect "roll forward exit code" "$RC" 0
expect "live release" "$(live_id)" "$ID6"

echo "== 16. --sync-api: health OK"
echo 'print("api v2")' > "$WORK/api/server.py"
echo 'y = 2' > "$WORK/api/extra.py"
run "$D" --sync-api --api-dir "$WORK/api"
expect "exit code" "$RC" 0
has "api live" "$OUT" "api/: live, sog-api restarted, /api/health 200"
expect "api/ on the hub" "$(on_hub 'cd /srv/hub/sog/api && find . -type f | sort | tr "\n" " "')" "./extra.py ./server.py "
expect "server.py is v2" "$(on_hub 'cat /srv/hub/sog/api/server.py')" 'print("api v2")'

echo "== 17. --sync-api: a file that does not parse is refused"
echo 'def broken(:' > "$WORK/api/extra.py"
run "$D" --sync-api --api-dir "$WORK/api"
expect "exit code" "$RC" 1
has "refused" "$OUT" "REFUSED: the new API does not parse"
expect "extra.py unchanged" "$(on_hub 'cat /srv/hub/sog/api/extra.py')" 'y = 2'

echo "== 18. --sync-api: health fails -> previous files back"
rm -f "$WORK/api/extra.py"
echo 'print("api v3")' > "$WORK/api/server.py"
docker stop "$APIC" >/dev/null
run "$D" --sync-api --api-dir "$WORK/api"
docker start "$APIC" >/dev/null
expect "exit code" "$RC" 1
has "rolled back" "$OUT" "ROLLED BACK: /api/health answered 50"
expect "server.py is v2 again" "$(on_hub 'cat /srv/hub/sog/api/server.py')" 'print("api v2")'
expect "extra.py is back" "$(on_hub 'cat /srv/hub/sog/api/extra.py')" 'y = 2'

echo "== 19. hub.env problems"
printf 'SOG_HOST=x\nnot a line\n' > "$WORK/hub-bad.env"
HUBENV="$WORK/hub-bad.env" run "$D" --check --dist "$WORK/dist1"
has "bad line refused" "$OUT" "hub-bad.env:2: expected SOG_NAME=value"
printf 'SOG_HOST=x\nSOG_BASE=/srv/hub/sog\nSOG_BACKUPS=/srv/hub/sog/backups\n' > "$WORK/hub-nested.env"
HUBENV="$WORK/hub-nested.env" run "$D" --check --dist "$WORK/dist1"
has "backups inside base refused" "$OUT" "SOG_BACKUPS must not be SOG_BASE or inside it"
HUBENV="$WORK/missing.env" run "$D" --check --dist "$WORK/dist1"
has "missing hub.env" "$OUT" "copy deploy/hub.env.example to deploy/hub.env"

echo "== 20. --check: read-only"
before=$(on_hub 'find /srv/hub -newer /srv/hub/sog/compose.yml | wc -l; ls -1 /srv/hub/sog/releases | wc -l')
run "$D" --check --dist "$WORK/dist2"
expect "exit code" "$RC" 0
has "check passes" "$OUT" "--check: preflight passed, nothing was uploaded or changed"
expect "release list unchanged" "$(on_hub 'ls -1 /srv/hub/sog/releases | wc -l')" "$(printf '%s\n' "$before" | tail -n 1)"
expect "live release" "$(live_id)" "$ID6"

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
