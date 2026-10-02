#!/usr/bin/env bash
# Ship the built web app (dist/) to the hub and switch to it atomically. Runs on the owner's machine
# (Git Bash on Windows, or any bash 4+ with ssh, tar, sha256sum, curl). Nothing is built on the hub.
#
#   bash deploy/deploy.sh                  # deploy dist/ (npm run build writes it)
#   bash deploy/deploy.sh --sync-config    # ... and first put deploy/nginx.conf live (tested, reloaded)
#   bash deploy/deploy.sh --check          # build the artifact and run the read-only preflight only
#   bash deploy/deploy.sh --init           # first-time setup of $SOG_BASE (dirs, compose, nginx, api)
#   bash deploy/deploy.sh --sync-api       # put api/ live: in place, restart sog-api, health or revert
# Options: --dist DIR (default dist), --api-dir DIR (default api), --insecure-tls (the public
# check accepts an untrusted certificate: only while the Let's Encrypt STAGING certificate is live).
#
# A deploy, in order (any failure stops it; after the switch a failure puts the previous release back):
#  1. artifact: dist/ copied without dotfiles. The release id is the "sha" of the build's own
#     release.json (web/scripts/post-build.mjs: a content hash), so the page, its error reports and
#     the hub's releases/<id>/ name the same release. A build without one gets deploy.sh's content
#     hash and a release.json {sha, built, commit} written for it. dist-<id>.tgz + its sha256.
#  2. preflight on the hub (read-only): $SOG_BASE exists, sog-web runs, free disk >= 2 GB and >= 3x
#     the artifact, and the hub's nginx.conf AND the copy sog-web sees equal deploy/nginx.conf
#     (unless --sync-config, which puts it live in step 5).
#  3. upload to incoming/ over ssh, `sha256sum -c` on the hub, unpack into releases/<id>/. An id
#     that is already there is kept when its content is identical and refused when it differs.
#  4. backup: $SOG_BASE without the releases and uploads, plus the live release and its symlink,
#     to $SOG_BACKUPS/sog-predeploy-<UTC>-<id>.tgz. No backup = no switch.
#  5. (--sync-config) the new nginx.conf is tested with `nginx -t` in a throwaway container, written
#     in place (same inode, so the single-file bind mount sees it), tested again inside sog-web and
#     reloaded; any failure puts the previous file back and stops before the switch.
#  6. switch: ln -sfn + mv -T (rename(2)), so a request sees the old or the new release, never half.
#     Then `nginx -t && nginx -s reload` in sog-web.
#  7. check inside sog-web: /release.json ("sha") names <id> and /en/ answers 200 with the CSP header; then
#     from this machine: $SOG_PUBLIC_URL/release.json names <id> and /en/ answers 200. Either check
#     failing puts the previous release back (the public one only while current is still <id>).
#  8. keep the newest $SOG_KEEP_RELEASES releases (never the live or the previous one) and the newest
#     $SOG_KEEP_BACKUPS sog-predeploy-*.tgz.
# Rollback by hand: bash deploy/rollback.sh <id>   (any release still in releases/)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

MODE=deploy
SYNC_CONFIG=0
INSECURE=0
DIST="$ROOT/dist"
API_DIR="$ROOT/api"
while [ $# -gt 0 ]; do
  case "$1" in
    --init) MODE=init ;;
    --check) MODE=check ;;
    --sync-api) MODE=sync-api ;;
    --sync-config) SYNC_CONFIG=1 ;;
    --insecure-tls) INSECURE=1 ;;
    --dist) DIST="${2:?--dist needs a directory}"; shift ;;
    --api-dir) API_DIR="${2:?--api-dir needs a directory}"; shift ;;
    -h | --help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d'; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done

load_hub_env "${SOG_HUB_ENV:-$HERE/hub.env}"
hub_setup

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ---------------------------------------------------------------------------------------------
# step 1: the artifact
build_artifact() {
  [ -d "$DIST" ] || die "no $DIST: build the web app first (npm run build)"
  [ -f "$DIST/en/index.html" ] || die "$DIST/en/index.html is missing: not a complete build"
  mkdir "$WORK/release"
  cp -R "$DIST/." "$WORK/release/"
  # dotfiles never ship (nginx answers 404 for them anyway)
  find "$WORK/release" -mindepth 1 -name '.*' -prune -exec rm -rf {} +
  local commit meta="" source
  commit=$(git -C "$ROOT" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)
  [ -f "$WORK/release/release.json" ] && meta=$(tr -d ' \r\n\t' < "$WORK/release/release.json")
  if [[ "$meta" =~ \"sha\":\"([0-9a-f]{12})\" ]]; then
    ID="${BASH_REMATCH[1]}"
    source="the build's release.json"
  else
    # no usable release.json: a content hash over every file's path and content, and our own file
    ID=$(cd "$WORK/release" && find . -type f ! -path ./release.json -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -c1-12)
    printf '{"sha":"%s","built":"%s","commit":"%s"}\n' "$ID" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$commit" > "$WORK/release/release.json"
    source="content hash by deploy.sh (the build wrote no release.json with a sha)"
  fi
  [[ "$ID" =~ ^[0-9a-f]{12}$ ]] || die "could not determine the release id"
  TGZ="$WORK/dist-$ID.tgz"
  tar -czf "$TGZ" -C "$WORK/release" .
  (cd "$WORK" && sha256sum "dist-$ID.tgz" > "dist-$ID.tgz.sha256")
  BYTES=$(wc -c < "$TGZ" | tr -d ' ')
  FILES=$(find "$WORK/release" -type f | wc -l | tr -d ' ')
  say "artifact: release $ID ($source; repo commit $commit), $FILES files, dist-$ID.tgz $BYTES bytes, sha256 $(cut -c1-64 < "$WORK/dist-$ID.tgz.sha256")"
}

# step 2: read-only preflight; fills PF[...] from key=value lines
declare -A PF
preflight() {
  local out line
  out=$(remote "$BASE" <<'REMOTE'
BASE="$1"
if [ -d "$BASE" ]; then echo "base=yes"; else echo "base=no"; fi
d="$BASE"; while [ ! -d "$d" ]; do d=$(dirname "$d"); done
echo "avail_kb=$(df -Pk "$d" | awk 'NR==2 {print $4}')"
h=$(sha256sum "$BASE/nginx.conf" 2>/dev/null | cut -c1-64)
echo "conf_hub=${h:-missing}"
r=$(docker inspect -f '{{.State.Running}}' sog-web 2>/dev/null || echo false)
echo "web_running=${r:-false}"
w=""
[ "$r" = true ] && w=$(docker exec sog-web sha256sum /etc/nginx/conf.d/default.conf 2>/dev/null | cut -c1-64)
echo "conf_web=${w:-missing}"
echo "current=$(readlink "$BASE/releases/current" 2>/dev/null || echo none)"
echo "preflight=done"
REMOTE
  ) || die "preflight over ssh failed (nothing was uploaded or changed)"
  while IFS= read -r line; do
    [[ "$line" =~ ^([a-z_]+)=(.*)$ ]] && PF["${BASH_REMATCH[1]}"]="${BASH_REMATCH[2]}"
  done <<< "$out"
  [ "${PF[preflight]:-}" = done ] || die "preflight gave no answer: $out"
}

# the guards of step 2; prints what it found, dies on a refusal
check_preflight() {
  local conf_repo need_kb
  conf_repo=$(sha256sum "$HERE/nginx.conf" | cut -c1-64)
  [ "${PF[base]}" = yes ] || die "REFUSED: $BASE does not exist on the hub: run 'bash deploy/deploy.sh --init' first"
  [ "${PF[web_running]}" = true ] || die "REFUSED: sog-web is not running on the hub (docker compose up -d in $BASE, see deploy/README.md). Nothing was uploaded."
  need_kb=$((BYTES * 3 / 1024))
  [ "$need_kb" -lt 2097152 ] && need_kb=2097152
  [[ "${PF[avail_kb]:-}" =~ ^[0-9]+$ ]] && [ "${PF[avail_kb]}" -ge "$need_kb" ] ||
    die "REFUSED: not enough free disk on the hub: ${PF[avail_kb]:-?} KiB free, need $need_kb KiB. Nothing was uploaded."
  say "hub: free disk ${PF[avail_kb]} KiB (need $need_kb), live release ${PF[current]}"
  if [ "$SYNC_CONFIG" = 1 ]; then
    say "nginx.conf: hub ${PF[conf_hub]:0:12}, inside sog-web ${PF[conf_web]:0:12}, repo ${conf_repo:0:12} (--sync-config: the repo's file goes live before the switch)"
    return 0
  fi
  if [ "${PF[conf_hub]}" != "$conf_repo" ]; then
    die "REFUSED: $BASE/nginx.conf on the hub (sha256 ${PF[conf_hub]}) is not this repo's deploy/nginx.conf ($conf_repo). Run with --sync-config to put it live. Nothing was uploaded."
  fi
  if [ "${PF[conf_web]}" != "$conf_repo" ]; then
    die "REFUSED: the hub file is right but sog-web still sees another nginx.conf (sha256 ${PF[conf_web]}). Run with --sync-config (it restarts sog-web if the file was replaced). Nothing was uploaded."
  fi
  say "nginx.conf: hub = inside sog-web = deploy/nginx.conf (sha256 ${conf_repo:0:12})"
}

# steps 3-8 on the hub (one ssh session, under a lock); prints PREV=<id|none> and SWITCHED=<id>
REMOTE_DEPLOY=$(cat <<'REMOTE'
set -euo pipefail
BASE="$1"; BACKUPS="$2"; ID="$3"; SYNC="$4"; KEEP_RELEASES="$5"; KEEP_BACKUPS="$6"; VHOST="$7"
cd "$BASE"
exec 9>>"$BASE/.deploy.lock"
flock -n 9 || { echo "REFUSED: another deploy or rollback holds $BASE/.deploy.lock"; exit 1; }
# whatever happens, the upload and a half-unpacked directory do not stay behind
trap 'rm -rf "incoming/dist-$ID.tgz" "incoming/dist-$ID.tgz.sha256" "releases/.tmp-$ID"' EXIT
# uploads left by deploys that were refused at the lock above, older than a day
find incoming -maxdepth 1 -type f -name 'dist-*' -mmin +1440 -exec rm -f {} + 2>/dev/null || true

web_running() { [ "$(docker inspect -f '{{.State.Running}}' sog-web 2>/dev/null || echo false)" = true ]; }
point() { ln -sfn "$1" releases/.current-new && mv -T releases/.current-new releases/current; }
wget_head() { docker exec sog-web wget -q -S -O /dev/null --header "Host: $VHOST" "http://127.0.0.1$1" 2>&1 || true; }
status_of() { wget_head "$1" | grep -E '^ +HTTP/' | tail -n 1 | awk '{print $2}'; }
served_id() {
  docker exec sog-web wget -q -O - --header "Host: $VHOST" "http://127.0.0.1/release.json?cb=$RANDOM" 2>/dev/null |
    tr -d ' \r\n\t' | sed -n 's/.*"sha":"\([0-9a-f]\{12\}\)".*/\1/p' || true
}

# 3. the upload: checksum, then unpack once per release id
(cd incoming && sha256sum -c --quiet "dist-$ID.tgz.sha256") || { echo "REFUSED: sha256 of the upload does not match"; exit 1; }
# digest of a release directory without its release.json (that holds the build time)
digest() { (cd "$1" && find . -type f ! -path ./release.json -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum | sha256sum | cut -c1-64); }
tmp="releases/.tmp-$ID"
rm -rf "$tmp" && mkdir -p "$tmp"
tar -xzf "incoming/dist-$ID.tgz" -C "$tmp" --no-same-owner --no-same-permissions
[ -f "$tmp/en/index.html" ] || { rm -rf "$tmp"; echo "REFUSED: the release has no en/index.html"; exit 1; }
rel=$(tr -d ' \r\n\t' < "$tmp/release.json" 2>/dev/null || true)
[[ "$rel" == *"\"sha\":\"$ID\""* ]] ||
  { rm -rf "$tmp"; echo "REFUSED: release.json in the artifact does not name $ID"; exit 1; }
if [ -d "releases/$ID" ]; then
  same=no
  [ "$(digest "$tmp")" = "$(digest "releases/$ID")" ] && same=yes
  rm -rf "$tmp"
  if [ "$same" = yes ]; then
    echo "release $ID is already on the hub with the same content: kept"
  else
    echo "REFUSED: releases/$ID already exists with DIFFERENT content (a stale release.json in the build?). Rebuild; nothing was changed"
    exit 1
  fi
else
  chmod -R u+rwX,go+rX,go-w "$tmp"
  mv -T "$tmp" "releases/$ID"
  echo "unpacked releases/$ID ($(find "releases/$ID" -type f | wc -l) files)"
fi
rm -f "incoming/dist-$ID.tgz" "incoming/dist-$ID.tgz.sha256"
prev=$(readlink releases/current 2>/dev/null || echo none)
echo "PREV=$prev"

# 4. backup BEFORE anything changes: the service directory without releases/ and incoming/, plus
# the live release and its symlink. config.env is inside, hence umask 077. tar exit 1 = a file
# changed while read (live counters in data/): kept.
mkdir -p "$BACKUPS"
bk="$BACKUPS/sog-predeploy-$(date -u +%Y%m%dT%H%M%SZ)-$ID.tgz"
items=()
shopt -s dotglob nullglob
for f in *; do
  case "$f" in releases | incoming | .deploy.lock) ;; *) items+=("$f") ;; esac
done
shopt -u dotglob nullglob
if [ -L releases/current ]; then
  items+=(releases/current)
  [ -d "releases/$prev" ] && items+=("releases/$prev")
fi
[ "${#items[@]}" -gt 0 ] || { echo "REFUSED: nothing to back up in $BASE: no switch"; exit 1; }
rc=0
(umask 077 && tar -czf "$bk" -- "${items[@]}") || rc=$?
[ "$rc" -le 1 ] || { rm -f "$bk"; echo "REFUSED: backup failed (tar exit $rc): no switch"; exit 1; }
n=$(tar -tzf "$bk" | wc -l) || { echo "REFUSED: the backup does not list: no switch"; exit 1; }
[ "$n" -gt 0 ] || { echo "REFUSED: the backup is empty: no switch"; exit 1; }
echo "backup $bk: $(stat -c %s "$bk") bytes, $n entries"

# 5. nginx.conf (--sync-config only)
if [ "$SYNC" = 1 ]; then
  [ -f nginx.conf.new ] || { echo "REFUSED: nginx.conf.new was not uploaded"; exit 1; }
  web_running || { rm -f nginx.conf.new; echo "REFUSED: sog-web is not running"; exit 1; }
  want=$(sha256sum nginx.conf.new | cut -c1-64)
  seen=$(docker exec sog-web sha256sum /etc/nginx/conf.d/default.conf 2>/dev/null | cut -c1-64 || true)
  if cmp -s nginx.conf.new nginx.conf && [ "$seen" = "$want" ]; then
    rm -f nginx.conf.new
    echo "nginx.conf: already live (sha256 ${want:0:12})"
  else
    img=$(docker inspect -f '{{.Config.Image}}' sog-web)
    if ! out=$(docker run --rm --network none \
        -v "$BASE/nginx.conf.new:/etc/nginx/conf.d/default.conf:ro" \
        -v "$BASE/releases:/srv/releases:ro" \
        --entrypoint nginx "$img" -t 2>&1); then
      printf '%s\n' "$out"
      rm -f nginx.conf.new
      echo "REFUSED: the new nginx.conf fails nginx -t in a throwaway $img container; nothing was changed"
      exit 1
    fi
    [ -f nginx.conf ] && cp -p nginx.conf nginx.conf.prev
    cat nginx.conf.new > nginx.conf   # in place: same inode, so sog-web's bind mount sees it
    rm -f nginx.conf.new
    seen=$(docker exec sog-web sha256sum /etc/nginx/conf.d/default.conf 2>/dev/null | cut -c1-64 || true)
    if [ "$seen" = "$want" ]; then
      if ! docker exec sog-web nginx -t >/dev/null 2>&1; then
        [ -f nginx.conf.prev ] && cat nginx.conf.prev > nginx.conf
        echo "REFUSED: nginx -t inside sog-web failed with the new nginx.conf; the previous file is back, nginx was not reloaded"
        exit 1
      fi
      if ! docker exec sog-web nginx -s reload >/dev/null 2>&1; then
        [ -f nginx.conf.prev ] && cat nginx.conf.prev > nginx.conf
        echo "ERROR: nginx -s reload failed in sog-web; the previous nginx.conf is back"
        exit 1
      fi
      echo "nginx.conf: written in place, tested in sog-web, reloaded (sha256 ${want:0:12})"
    else
      # the hub file was replaced at some time (new inode): sog-web reads it only after a restart
      docker restart sog-web >/dev/null
      for _ in $(seq 1 30); do
        web_running && [ "$(status_of /healthz)" = 200 ] && break
        sleep 1
      done
      seen=$(docker exec sog-web sha256sum /etc/nginx/conf.d/default.conf 2>/dev/null | cut -c1-64 || true)
      [ "$seen" = "$want" ] || { echo "ERROR: after a restart sog-web sees nginx.conf ${seen:-?}, not $want"; exit 1; }
      echo "nginx.conf: sog-web restarted to read the new file (sha256 ${want:0:12})"
    fi
  fi
fi

# 6. switch, test, reload
revert() {
  if [ "$prev" != none ] && [ -d "releases/$prev" ]; then point "$prev"; else rm -f releases/current; fi
  if web_running && docker exec sog-web nginx -t >/dev/null 2>&1; then docker exec sog-web nginx -s reload >/dev/null 2>&1 || true; fi
  echo "ROLLED BACK: $1; current -> $(readlink releases/current 2>/dev/null || echo none)"
  exit 1
}
point "$ID"
touch "releases/$ID"   # newest first in `ls -t`, for the pruning below and rollback.sh's list
echo "current -> $ID (was $prev)"
web_running || revert "sog-web is not running"
docker exec sog-web nginx -t >/dev/null 2>&1 || revert "nginx -t failed in sog-web"
docker exec sog-web nginx -s reload >/dev/null 2>&1 || revert "nginx -s reload failed in sog-web"

# 7. check inside sog-web (the reload reaches new workers within moments)
got="" code="" csp=no
for _ in $(seq 1 20); do
  got=$(served_id)
  head=$(wget_head /en/)
  code=$(printf '%s\n' "$head" | grep -E '^ +HTTP/' | tail -n 1 | awk '{print $2}')
  csp=no
  [[ "${head,,}" == *"content-security-policy:"* ]] && csp=yes
  [ "$got" = "$ID" ] && [ "$code" = 200 ] && [ "$csp" = yes ] && break
  sleep 0.5
done
[ "$got" = "$ID" ] && [ "$code" = 200 ] && [ "$csp" = yes ] ||
  revert "sog-web serves release '${got:-none}', /en/ ${code:-no answer}, CSP header $csp (wanted $ID, 200, yes)"
echo "sog-web: /release.json names $ID, /en/ 200 with the CSP header"

# 8. keep the newest releases (never the live or the previous one) and the newest backups
ls -1t releases | { grep -E '^[0-9a-f]{12}$' || true; } | tail -n +"$((KEEP_RELEASES + 1))" | while read -r old; do
  { [ "$old" = "$ID" ] || [ "$old" = "$prev" ]; } && continue
  rm -rf "releases/$old" && echo "pruned release $old"
done
ls -1t "$BACKUPS" | { grep -E '^sog-predeploy-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}\.tgz$' || true; } |
  tail -n +"$((KEEP_BACKUPS + 1))" | while read -r old; do
  rm -f "$BACKUPS/$old" && echo "pruned backup $old"
done
echo "SWITCHED=$ID"
REMOTE
)

# put PREV back after a failed public check, but only while current is still ID
REMOTE_UNDO=$(cat <<'REMOTE'
set -euo pipefail
BASE="$1"; ID="$2"; PREV="$3"
cd "$BASE"
exec 9>>"$BASE/.deploy.lock"
locked=no
for _ in $(seq 1 30); do flock -n 9 && { locked=yes; break; }; sleep 1; done   # (busybox flock has no -w)
[ "$locked" = yes ] || { echo "could not take $BASE/.deploy.lock in 30 s: nothing changed"; exit 1; }
cur=$(readlink releases/current 2>/dev/null || echo none)
[ "$cur" = "$ID" ] || { echo "current is $cur, no longer $ID: left as it is"; exit 1; }
[ -d "releases/$PREV" ] || { echo "releases/$PREV is gone: left as it is"; exit 1; }
ln -sfn "$PREV" releases/.current-new && mv -T releases/.current-new releases/current
if docker exec sog-web nginx -t >/dev/null 2>&1; then docker exec sog-web nginx -s reload >/dev/null 2>&1 || true; fi
echo "ROLLED BACK: current -> $PREV"
REMOTE
)

do_deploy() {
  build_artifact
  preflight
  check_preflight
  [ "$MODE" = check ] && { say "--check: preflight passed, nothing was uploaded or changed"; return 0; }

  "${SSH[@]}" "mkdir -p $(rq "$BASE/incoming" "$BASE/releases" "$BASE/data")"
  upload "$TGZ" "$BASE/incoming/dist-$ID.tgz"
  upload "$WORK/dist-$ID.tgz.sha256" "$BASE/incoming/dist-$ID.tgz.sha256"
  [ "$SYNC_CONFIG" = 1 ] && upload "$HERE/nginx.conf" "$BASE/nginx.conf.new"
  say "uploaded dist-$ID.tgz to $BASE/incoming/"

  local out rc=0
  out=$(remote "$BASE" "$BACKUPS" "$ID" "$SYNC_CONFIG" "$KEEP_RELEASES" "$KEEP_BACKUPS" "$VHOST" <<< "$REMOTE_DEPLOY" | tee /dev/stderr) || rc=$?
  [ "$rc" = 0 ] && [[ "$out" == *"SWITCHED=$ID"* ]] || die "deploy of $ID stopped on the hub (see above)"
  local prev
  prev=$(printf '%s\n' "$out" | sed -n 's/^PREV=//p' | tail -n 1)

  if wait_public "$ID"; then
    say "DONE: release $ID is live at $PUBLIC_URL/en/ (previous: $prev)"
    return 0
  fi
  if [ -n "$prev" ] && [ "$prev" != none ]; then
    if remote "$BASE" "$ID" "$prev" <<< "$REMOTE_UNDO"; then
      die "the public check failed: the previous release $prev was put back (see above)"
    fi
    die "the public check failed AND the previous release $prev could NOT be put back: $ID is still live on the hub. Look at the site now; bash deploy/rollback.sh $prev"
  fi
  die "the public check failed and there is no previous release to put back: $ID stays live (first deploy? DNS or certificate not ready? try --insecure-tls while the staging certificate is live)"
}

# ---------------------------------------------------------------------------------------------
# --init: first-time setup. Refuses when sog-web or sog-api already exist (then it is not the
# first time: use --sync-config / --sync-api). Never touches config.env: it prints the command.
do_init() {
  [ -f "$API_DIR/server.py" ] || die "no $API_DIR/server.py: the API must exist before --init"
  mkdir -p "$WORK/payload/api"
  cp "$HERE/compose.yml" "$HERE/compose.staging.yml" "$HERE/nginx.conf" "$WORK/payload/"
  copy_api "$WORK/payload/api"
  tar -czf "$WORK/init-payload.tgz" -C "$WORK/payload" .

  remote "$BASE" "$BACKUPS" <<'REMOTE' || die "--init refused (see above): nothing was changed"
set -euo pipefail
BASE="$1"; BACKUPS="$2"
names=$(docker ps -a --format '{{.Names}}')
if [ "$(printf '%s\n' "$names" | grep -cxE 'sog-(web|api)' || true)" != 0 ]; then
  echo "REFUSED: sog-web or sog-api already exists: this is not a first-time setup."
  echo "Use deploy.sh --sync-config (nginx.conf) or --sync-api (api/); compose.yml changes are in deploy/README.md."
  exit 1
fi
docker network inspect web-proxy >/dev/null 2>&1 || { echo "REFUSED: the external network web-proxy does not exist on this host"; exit 1; }
mkdir -p "$BASE/releases" "$BASE/incoming" "$BASE/data" "$BASE/api" "$BACKUPS"
echo "directories ready under $BASE"
REMOTE

  upload "$WORK/init-payload.tgz" "$BASE/incoming/init-payload.tgz"
  remote "$BASE" <<'REMOTE' || die "--init failed while installing the files (see above)"
set -euo pipefail
BASE="$1"
cd "$BASE"
rm -rf .init-tmp && mkdir .init-tmp
tar -xzf incoming/init-payload.tgz -C .init-tmp --no-same-owner --no-same-permissions
for f in compose.yml compose.staging.yml nginx.conf; do
  if [ -f "$f" ] && ! cmp -s ".init-tmp/$f" "$f"; then cp -p "$f" "$f.prev"; echo "kept the old $f as $f.prev"; fi
  cat ".init-tmp/$f" > "$f"   # in place (nginx.conf may already be a bind-mount source)
  chmod 644 "$f"
done
cp -R .init-tmp/api/. api/
chmod -R u+rwX,go+rX,go-w api
rm -rf .init-tmp incoming/init-payload.tgz
echo "installed: compose.yml compose.staging.yml nginx.conf api/ ($(find api -type f | wc -l) files)"
if [ -f config.env ]; then
  echo "config.env: present, $(grep -c '=' config.env) lines (values not shown)"
else
  echo "config.env: MISSING (docker compose refuses to start sog-api without it)"
fi
REMOTE

  local src="${SOG_TG_CONFIG_SRC:-<an existing config.env with TG_BOT_TOKEN and TG_CHAT_ID>}" cmd
  cmd="(umask 077 && grep -E \"^(TG_BOT_TOKEN|TG_CHAT_ID)=\" $(rq "$src") > $(rq "$BASE/config.env")) && grep -c = $(rq "$BASE/config.env")"
  say ""
  say "Next (deploy/README.md, 'First deploy'). Not run by this script:"
  say "1. config.env with the two Telegram lines only (prints the line count, 2; never the values). On the hub:"
  say "     $cmd"
  say "   or from this machine:"
  say "     bash deploy/hub.sh $(sq "$cmd")"
  say "2. start with the STAGING certificate:"
  say "     bash deploy/hub.sh $(sq "cd $(rq "$BASE") && docker compose -f compose.yml -f compose.staging.yml up -d")"
  say "3. first release: bash deploy/deploy.sh --insecure-tls"
}

# api/ without tests, caches and dotfiles
copy_api() {
  local dst="$1"
  [ -d "$API_DIR" ] || die "no $API_DIR"
  cp -R "$API_DIR/." "$dst/"
  find "$dst" -mindepth 1 \( -name '.*' -o -name '__pycache__' -o -name 'tests' -o -name '*.pyc' \) -prune -exec rm -rf {} +
}

# ---------------------------------------------------------------------------------------------
# --sync-api: api/ goes live in place (the directory mount sees new files), sog-api restarts and
# /api/health must answer 200 through sog-web within 30 s, or the previous files come back.
do_sync_api() {
  [ -f "$API_DIR/server.py" ] || die "no $API_DIR/server.py"
  mkdir -p "$WORK/api"
  copy_api "$WORK/api"
  tar -czf "$WORK/api-payload.tgz" -C "$WORK/api" .
  upload "$WORK/api-payload.tgz" "$BASE/incoming/api-payload.tgz"
  remote "$BASE" "$VHOST" <<'REMOTE' || die "--sync-api stopped (see above)"
set -euo pipefail
BASE="$1"; VHOST="$2"
cd "$BASE"
exec 9>>"$BASE/.deploy.lock"
flock -n 9 || { echo "REFUSED: another deploy holds $BASE/.deploy.lock"; exit 1; }
docker inspect sog-api >/dev/null 2>&1 || { echo "REFUSED: no sog-api container (start it with docker compose up -d first)"; exit 1; }
rm -rf api.new && mkdir api.new
tar -xzf incoming/api-payload.tgz -C api.new --no-same-owner --no-same-permissions
rm -f incoming/api-payload.tgz
chmod -R u+rwX,go+rX,go-w api.new
[ -f api.new/server.py ] || { rm -rf api.new; echo "REFUSED: no server.py in the upload"; exit 1; }
# syntax check with the API's own python image, before anything changes
img=$(docker inspect -f '{{.Config.Image}}' sog-api)
if ! out=$(docker run --rm --network none -v "$BASE/api.new:/app:ro" --entrypoint python "$img" -c \
    'import ast, pathlib, sys; [ast.parse(p.read_text(encoding="utf-8"), str(p)) for p in pathlib.Path("/app").rglob("*.py")]' 2>&1); then
  printf '%s\n' "$out"; rm -rf api.new
  echo "REFUSED: the new API does not parse with $img; nothing was changed"
  exit 1
fi
# copy SRC over DST in place and drop files SRC no longer has
sync_tree() {
  cp -R "$1/." "$2/"
  (cd "$2" && find . -type f) | while IFS= read -r f; do [ -e "$1/$f" ] || rm -f "$2/$f"; done
}
health() {
  docker exec sog-web wget -q -S -O /dev/null --header "Host: $VHOST" http://127.0.0.1/api/health 2>&1 |
    grep -E '^ +HTTP/' | tail -n 1 | awk '{print $2}' || true
}
rm -rf api.prev && cp -R api api.prev
sync_tree api.new api
docker restart sog-api >/dev/null
code=""
for _ in $(seq 1 30); do code=$(health); [ "$code" = 200 ] && break; sleep 1; done
if [ "$code" != 200 ]; then
  sync_tree api.prev api
  docker restart sog-api >/dev/null
  rm -rf api.new
  echo "ROLLED BACK: /api/health answered ${code:-nothing} after the restart; the previous api/ is back and sog-api restarted"
  exit 1
fi
rm -rf api.new
echo "api/: live, sog-api restarted, /api/health 200 (previous files kept in $BASE/api.prev)"
REMOTE
}

case "$MODE" in
  deploy | check) do_deploy ;;
  init) do_init ;;
  sync-api) do_sync_api ;;
esac
