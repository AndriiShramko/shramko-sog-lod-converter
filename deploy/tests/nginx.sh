#!/usr/bin/env bash
# Local test of deploy/nginx.conf in the real image (nginx:1.29-alpine), no hub involved.
#   bash deploy/tests/nginx.sh
# Needs Docker and curl. Creates, and removes at the end, a network, a volume and two containers,
# all named sog-nginx-test*: nginx with the repo's nginx.conf and a fake release behind a symlink
# (releases/current -> aaaaaaaaaaaa, as on the hub), and a fake API (python:3.12-alpine, the API's
# image) under the network alias "sog-api" that echoes what it receives, so the proxy rules can be
# checked: real client address, no cookies, body limits, methods.
set -euo pipefail
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF="$HERE/../nginx.conf"
command -v cygpath >/dev/null 2>&1 && CONF="$(cygpath -m "$CONF")"
NET=sog-nginx-test
VOL=sog-nginx-test-releases
WEB=sog-nginx-test-web
API=sog-nginx-test-api
PORT="${SOG_TEST_PORT:-18080}"
URL="http://127.0.0.1:$PORT"
IMG=nginx:1.29-alpine
PYIMG=python:3.12-alpine

cleanup() {
  docker rm -f "$WEB" "$API" >/dev/null 2>&1 || true
  docker volume rm "$VOL" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
cleanup
trap cleanup EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$*"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n' "$*"; }
# expect NAME ACTUAL WANTED
expect() { if [ "$2" = "$3" ]; then ok "$1: $2"; else bad "$1: got '$2', want '$3'"; fi; }
# has NAME HAYSTACK NEEDLE
has() { if [[ "$2" == *"$3"* ]]; then ok "$1"; else bad "$1: '$3' not in: $2"; fi; }
hdr() { printf '%s\n' "$1" | tr -d '\r' | grep -i "^$2:" | head -n 1 | cut -d' ' -f2-; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "== 1. nginx -t on deploy/nginx.conf (no API container exists yet)"
docker run --rm -v "$CONF:/etc/nginx/conf.d/default.conf:ro" --entrypoint nginx "$IMG" -t

echo "== 2. fake release in a volume: releases/aaaaaaaaaaaa, current -> aaaaaaaaaaaa"
docker network create "$NET" >/dev/null
docker volume create "$VOL" >/dev/null
docker run --rm -v "$VOL:/srv/releases" --entrypoint sh "$IMG" -c '
set -e
r=/srv/releases/aaaaaaaaaaaa
mkdir -p "$r/en" "$r/es" "$r/pl" "$r/ru" "$r/assets" "$r/.git"
for l in en es pl ru; do printf "<!doctype html><title>%s</title><script type=module src=/assets/app-1a2b3c.js></script>\n" "$l" > "$r/$l/index.html"; done
head -c 300000 /dev/urandom > "$r/assets/x.wasm"
printf "\0asm\1\0\0\0" > "$r/assets/hdr.wasm"
yes "export const a = 1;" | head -n 400 > "$r/assets/app-1a2b3c.js"
cp "$r/assets/app-1a2b3c.js" "$r/assets/worker-9f8e.mjs"
echo "{\"sha\":\"aaaaaaaaaaaa\",\"built\":\"2026-10-02T00:00:00.000Z\"}" > "$r/release.json"
echo "<!doctype html><title>404</title>" > "$r/404.html"
echo "[core]" > "$r/.git/config"
echo "SECRET=1" > "$r/.env"
ln -sfn aaaaaaaaaaaa /srv/releases/current
ls -la /srv/releases'

echo "== 3. nginx up FIRST (sog-api does not exist yet: the variable proxy_pass must still start)"
docker run -d --name "$WEB" --network "$NET" -p "127.0.0.1:$PORT:80" \
  -v "$CONF:/etc/nginx/conf.d/default.conf:ro" -v "$VOL:/srv/releases:ro" "$IMG" >/dev/null
for _ in $(seq 1 40); do [ "$(code "$URL/healthz")" = 200 ] && break; sleep 0.25; done
expect "/api/health while no API container exists" "$(code "$URL/api/health")" 502

echo "== 4. language redirect at /"
h=$(curl -s -D - -o /dev/null "$URL/")
expect "/ no Accept-Language -> status" "$(printf '%s' "$h" | head -n 1 | awk '{print $2}')" 302
expect "/ no Accept-Language -> Location" "$(hdr "$h" Location)" "/en/"
expect "/ Accept-Language pl" "$(hdr "$(curl -s -D - -o /dev/null -H 'Accept-Language: pl-PL,pl;q=0.9,en;q=0.8' "$URL/")" Location)" "/pl/"
expect "/ Accept-Language es" "$(hdr "$(curl -s -D - -o /dev/null -H 'Accept-Language: es-ES' "$URL/")" Location)" "/es/"
expect "/ Accept-Language ru" "$(hdr "$(curl -s -D - -o /dev/null -H 'Accept-Language: ru-RU,ru;q=0.9' "$URL/")" Location)" "/ru/"
expect "/ Accept-Language uk -> ru" "$(hdr "$(curl -s -D - -o /dev/null -H 'Accept-Language: uk-UA' "$URL/")" Location)" "/ru/"
expect "/ Accept-Language de -> en" "$(hdr "$(curl -s -D - -o /dev/null -H 'Accept-Language: de-DE,pl;q=0.5' "$URL/")" Location)" "/en/"
expect "/ cookie sog_lang=es beats Accept-Language ru" "$(hdr "$(curl -s -D - -o /dev/null -H 'Cookie: sog_lang=es' -H 'Accept-Language: ru' "$URL/")" Location)" "/es/"
expect "/ bad cookie sog_lang=xx falls back to Accept-Language pl" "$(hdr "$(curl -s -D - -o /dev/null -H 'Cookie: sog_lang=xx' -H 'Accept-Language: pl' "$URL/")" Location)" "/pl/"
expect "/?utm_source=x keeps the query" "$(hdr "$(curl -s -D - -o /dev/null "$URL/?utm_source=x")" Location)" "/en/?utm_source=x"
expect "/ Vary" "$(hdr "$h" Vary)" "Cookie, Accept-Language"
expect "/en -> 301" "$(code "$URL/en")" 301
expect "/en -> Location" "$(hdr "$(curl -s -D - -o /dev/null "$URL/en")" Location)" "/en/"

echo "== 5. locale pages and headers"
CSP_WANT="default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://www.googletagmanager.com; worker-src 'self' blob:; connect-src 'self' https://www.google-analytics.com https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com; img-src 'self' data: blob: https://www.googletagmanager.com https://*.google-analytics.com; style-src 'self' 'unsafe-inline'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
h=$(curl -s -D - -o /dev/null "$URL/en/")
printf '%s' "$h" | tr -d '\r'
expect "/en/ status" "$(printf '%s' "$h" | head -n 1 | awk '{print $2}')" 200
expect "/en/ CSP (enforced, exact)" "$(hdr "$h" Content-Security-Policy)" "$CSP_WANT"
expect "/en/ no Report-Only" "$(hdr "$h" Content-Security-Policy-Report-Only)" ""
expect "/en/ no COEP" "$(hdr "$h" Cross-Origin-Embedder-Policy)" ""
expect "/en/ Cache-Control" "$(hdr "$h" Cache-Control)" "no-cache"
expect "/en/ Server header has no version" "$(hdr "$h" Server)" "nginx"
for l in es pl ru; do expect "/$l/ status" "$(code "$URL/$l/")" 200; done
expect "/de/ (no such locale)" "$(code "$URL/de/")" 404
expect "/en/nope.html" "$(code "$URL/en/nope.html")" 404

echo "== 6. every kind of response carries the full security header set"
check_headers() {
  local name="$1" h
  shift
  h=$(curl -s -D - -o /dev/null "$@")
  local missing=""
  for k in X-Content-Type-Options Referrer-Policy X-Frame-Options Permissions-Policy Content-Security-Policy; do
    [ -n "$(hdr "$h" "$k")" ] || missing="$missing $k"
  done
  if [ -z "$missing" ] && [ "$(hdr "$h" X-Frame-Options)" = DENY ] && [ "$(hdr "$h" X-Content-Type-Options)" = nosniff ] &&
    [ "$(hdr "$h" Referrer-Policy)" = strict-origin-when-cross-origin ]; then
    ok "headers on $name"
  else
    bad "headers on $name: missing$missing"
  fi
}
check_headers "/ (302)" "$URL/"
check_headers "/en (301)" "$URL/en"
check_headers "/en/ (200)" "$URL/en/"
check_headers "/assets/app-1a2b3c.js" "$URL/assets/app-1a2b3c.js"
check_headers "/assets/x.wasm" "$URL/assets/x.wasm"
check_headers "/release.json" "$URL/release.json"
check_headers "/healthz" "$URL/healthz"
check_headers "/.git/config (404)" "$URL/.git/config"
check_headers "/missing (404)" "$URL/missing"
check_headers "/api/nope (404)" "$URL/api/nope"
check_headers "/api/stats (403)" "$URL/api/stats"
check_headers "/api/report GET (403)" "$URL/api/report"
pp=$(hdr "$(curl -s -D - -o /dev/null "$URL/en/")" Permissions-Policy)
has "Permissions-Policy allows screen-wake-lock for self" "$pp" "screen-wake-lock=(self)"
has "Permissions-Policy denies camera" "$pp" "camera=()"
has "Permissions-Policy denies microphone" "$pp" "microphone=()"
has "Permissions-Policy denies geolocation" "$pp" "geolocation=()"

echo "== 7. assets, wasm, release.json, healthz"
h=$(curl -s -D - -o /dev/null -H 'Accept-Encoding: gzip' "$URL/assets/x.wasm")
printf '%s' "$h" | tr -d '\r'
expect "x.wasm Content-Type" "$(hdr "$h" Content-Type)" "application/wasm"
expect "x.wasm Cache-Control" "$(hdr "$h" Cache-Control)" "public, max-age=31536000, immutable"
expect "x.wasm gzip" "$(hdr "$h" Content-Encoding)" "gzip"
expect "hdr.wasm (small) Content-Type" "$(hdr "$(curl -s -D - -o /dev/null "$URL/assets/hdr.wasm")" Content-Type)" "application/wasm"
h=$(curl -s -D - -o /dev/null -H 'Accept-Encoding: gzip' "$URL/assets/app-1a2b3c.js")
expect "app.js Content-Type" "$(hdr "$h" Content-Type)" "application/javascript; charset=utf-8"
expect "app.js Cache-Control" "$(hdr "$h" Cache-Control)" "public, max-age=31536000, immutable"
expect "app.js gzip" "$(hdr "$h" Content-Encoding)" "gzip"
expect "worker.mjs Content-Type" "$(hdr "$(curl -s -D - -o /dev/null "$URL/assets/worker-9f8e.mjs")" Content-Type)" "application/javascript; charset=utf-8"
expect "/assets/missing.js" "$(code "$URL/assets/missing.js")" 404
h=$(curl -s -D - "$URL/release.json")
expect "release.json Cache-Control" "$(hdr "$h" Cache-Control)" "no-cache"
expect "release.json Content-Type" "$(hdr "$h" Content-Type)" "application/json"
has "release.json body" "$h" '"sha":"aaaaaaaaaaaa"'
expect "/healthz" "$(curl -s "$URL/healthz")" "ok"
expect "/healthz status" "$(code "$URL/healthz")" 200

echo "== 8. dotfiles"
expect "/.git/config" "$(code "$URL/.git/config")" 404
expect "/.git" "$(code "$URL/.git")" 404
expect "/.env" "$(code "$URL/.env")" 404
expect "/en/.hidden" "$(code "$URL/en/.hidden")" 404
expect "/assets/.x.js" "$(code "$URL/assets/.x.js")" 404
has "/.env body is not the file" "$(curl -s "$URL/.env")" "404"

echo "== 9. release switch by symlink only (no reload): current -> bbbbbbbbbbbb"
docker run --rm -v "$VOL:/srv/releases" --entrypoint sh "$IMG" -c '
set -e
cp -a /srv/releases/aaaaaaaaaaaa /srv/releases/bbbbbbbbbbbb
sed -i s/aaaaaaaaaaaa/bbbbbbbbbbbb/ /srv/releases/bbbbbbbbbbbb/release.json
ln -sfn bbbbbbbbbbbb /srv/releases/.current-new && mv -T /srv/releases/.current-new /srv/releases/current'
has "release.json after the switch" "$(curl -s "$URL/release.json")" '"sha":"bbbbbbbbbbbb"'

echo "== 10. API proxy with a fake sog-api (started AFTER nginx: re-resolved via Docker DNS)"
docker run -d --name "$API" --network "$NET" --network-alias sog-api "$PYIMG" python -u -c '
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
class H(BaseHTTPRequestHandler):
    def _send(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b""
        out = json.dumps({"path": self.path, "method": self.command, "bytes": len(body),
                          "headers": {k.lower(): v for k, v in self.headers.items()}}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)
    do_GET = do_POST = _send
    def log_message(self, *a):
        pass
ThreadingHTTPServer(("0.0.0.0", 8090), H).serve_forever()' >/dev/null
st=""
for _ in $(seq 1 60); do st=$(code "$URL/api/health"); [ "$st" = 200 ] && break; sleep 0.5; done
expect "/api/health once sog-api exists (within 30 s)" "$st" 200
# the client the hub's nginx-proxy would announce: it APPENDS the real address (9.9.9.9) to whatever
# the visitor sent (a forged 6.6.6.6); the request reaches sog-web from a private docker address
b=$(curl -s -X POST -H 'Content-Type: application/json' -H 'Cookie: session=abc' -H 'Authorization: Bearer x' \
  -H 'X-Forwarded-For: 6.6.6.6, 9.9.9.9' -d '{"kind":"idea","message":"hi"}' "$URL/api/report")
echo "API saw: $b"
has "/api/report reaches the API" "$b" '"path": "/api/report"'
has "API gets X-Real-IP = the appended (real) address" "$b" '"x-real-ip": "9.9.9.9"'
has "API gets X-Forwarded-For = only that address" "$b" '"x-forwarded-for": "9.9.9.9"'
if [[ "$b" == *'"cookie"'* ]]; then bad "Cookie reached the API"; else ok "Cookie stripped"; fi
if [[ "$b" == *'"authorization"'* ]]; then bad "Authorization reached the API"; else ok "Authorization stripped"; fi
expect "GET /api/report" "$(code "$URL/api/report")" 403
expect "POST /api/report 500 KB" "$(head -c 512000 /dev/zero | tr '\0' a | curl -s -o /dev/null -w '%{http_code}' -X POST --data-binary @- "$URL/api/report")" 200
expect "POST /api/report 600 KB" "$(head -c 614400 /dev/zero | tr '\0' a | curl -s -o /dev/null -w '%{http_code}' -X POST --data-binary @- "$URL/api/report")" 413
expect "POST /api/lead 8 KB" "$(head -c 8000 /dev/zero | tr '\0' a | curl -s -o /dev/null -w '%{http_code}' -X POST --data-binary @- "$URL/api/lead")" 200
expect "POST /api/lead 9 KB" "$(head -c 9216 /dev/zero | tr '\0' a | curl -s -o /dev/null -w '%{http_code}' -X POST --data-binary @- "$URL/api/lead")" 413
expect "POST /api/e 9 KB" "$(head -c 9216 /dev/zero | tr '\0' a | curl -s -o /dev/null -w '%{http_code}' -X POST --data-binary @- "$URL/api/e")" 413
expect "POST /api/e small" "$(code -X POST -d '{"e":"page_view"}' "$URL/api/e")" 200
expect "GET /api/e" "$(code "$URL/api/e")" 403
expect "/api/other -> JSON 404 from nginx" "$(curl -s "$URL/api/other")" '{"ok":false}'
expect "/api/stats from outside" "$(code "$URL/api/stats")" 403
expect "/api/stats with forged X-Forwarded-For: 127.0.0.1" "$(code -H 'X-Forwarded-For: 127.0.0.1' "$URL/api/stats")" 403
inside=$(docker exec "$WEB" wget -q -O - http://127.0.0.1/api/stats 2>&1 || true)
has "/api/stats from inside sog-web reaches the API" "$inside" '"path": "/api/stats"'

echo "== 11. the API container is recreated (new address): nginx finds it again"
ipof() { docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$1"; }
old_ip=$(ipof "$API")
docker rm -f "$API" >/dev/null
docker run -d --name "$API-blocker" --network "$NET" "$PYIMG" sleep 120 >/dev/null  # takes the old address
docker run -d --name "$API" --network "$NET" --network-alias sog-api "$PYIMG" python -u -c '
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.send_header("Content-Length", "11"); self.end_headers(); self.wfile.write(b"{\"ok\":true}")
    def log_message(self, *a):
        pass
ThreadingHTTPServer(("0.0.0.0", 8090), H).serve_forever()' >/dev/null
st=""
for _ in $(seq 1 60); do st=$(code "$URL/api/health"); [ "$st" = 200 ] && break; sleep 0.5; done
new_ip=$(ipof "$API")
if [ "$old_ip" != "$new_ip" ]; then ok "API address changed: $old_ip -> $new_ip"; else bad "API address did not change ($old_ip): the re-resolve was not exercised"; fi
expect "/api/health after the API container was recreated" "$st" 200
docker rm -f "$API-blocker" >/dev/null

echo "== 12. nginx error log (expected: nothing at [emerg] or [crit])"
errs=$(docker logs "$WEB" 2>&1 | grep -E '\[(emerg|crit)\]' || true)
expect "[emerg]/[crit] lines in the nginx log" "${errs:-none}" none

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
