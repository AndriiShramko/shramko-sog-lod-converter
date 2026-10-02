# Shared by deploy.sh, rollback.sh and hub.sh (sourced, not run). Bash 4+, Git Bash on Windows or
# any Linux/macOS shell.
#
# deploy/hub.env is PARSED here, never sourced or exported: Git Bash rewrites exported values that
# look like POSIX paths (/srv/sog -> C:/Program Files/Git/srv/sog) when it starts a native Windows
# program, and a sourced file could run code. Values become plain, unexported shell variables.

# Git Bash: never rewrite arguments that look like paths when calling native programs (ssh.exe,
# docker.exe): remote paths must reach the hub exactly as written. No effect elsewhere.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

# shell-quote every argument for the remote shell (ssh joins its arguments into one command line)
rq() {
  local out="" a
  for a in "$@"; do out+="$(printf '%q' "$a") "; done
  printf '%s' "${out% }"
}

# sq STRING: one single-quoted word for a command line a person copies (no %q backslashes)
sq() {
  local q="'" r="'\\''"
  printf "'%s'" "${1//$q/$r}"
}

# load_hub_env FILE: every "SOG_NAME=value" line becomes the variable SOG_NAME; blank lines and
# "# ..." lines are skipped; one pair of surrounding quotes is removed; anything else is an error.
load_hub_env() {
  local file="$1" line key val n=0
  [ -f "$file" ] || die "missing $file: copy deploy/hub.env.example to deploy/hub.env and fill it in"
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    case "$line" in '' | '#'*) continue ;; esac
    [[ "$line" =~ ^(SOG_[A-Z0-9_]+)=(.*)$ ]] || die "$file:$n: expected SOG_NAME=value"
    key="${BASH_REMATCH[1]}"
    val="${BASH_REMATCH[2]}"
    val="${val%"${val##*[![:space:]]}"}"
    if [[ "$val" =~ ^\"(.*)\"$ ]] || [[ "$val" =~ ^\'(.*)\'$ ]]; then val="${BASH_REMATCH[1]}"; fi
    printf -v "$key" '%s' "$val"
  done < "$file"
}

# hub_setup: checks the keys and builds SSH (an array), BASE, BACKUPS, PUBLIC_URL, VHOST, KEEP_*.
hub_setup() {
  : "${SOG_HOST:?set SOG_HOST in deploy/hub.env}"
  : "${SOG_BASE:?set SOG_BASE in deploy/hub.env}"
  : "${SOG_BACKUPS:?set SOG_BACKUPS in deploy/hub.env}"
  BASE="${SOG_BASE%/}"
  BACKUPS="${SOG_BACKUPS%/}"
  case "$BASE" in /?*) ;; *) die "SOG_BASE must be an absolute path below / (got '$SOG_BASE')" ;; esac
  case "$BACKUPS" in /?*) ;; *) die "SOG_BACKUPS must be an absolute path below / (got '$SOG_BACKUPS')" ;; esac
  case "$BACKUPS/" in "$BASE"/*) die "SOG_BACKUPS must not be SOG_BASE or inside it (backups would back up backups)" ;; esac
  local key="${SOG_KEY:-~/.ssh/id_ed25519}"
  key="${key/#\~/$HOME}"
  # C:/Users/... is understood by both Git Bash's ssh and Windows' own ssh.exe
  if command -v cygpath >/dev/null 2>&1; then key="$(cygpath -m "$key")"; fi
  SSH_OPTS=(-p "${SOG_PORT:-22}" -i "$key" -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=15)
  SSH=(ssh "${SSH_OPTS[@]}" "$SOG_HOST")
  PUBLIC_URL="${SOG_PUBLIC_URL:-https://sog.flyreelstudio.eu}"
  PUBLIC_URL="${PUBLIC_URL%/}"
  VHOST="${SOG_VHOST:-sog.flyreelstudio.eu}"
  KEEP_RELEASES="${SOG_KEEP_RELEASES:-5}"
  KEEP_BACKUPS="${SOG_KEEP_BACKUPS:-10}"
  [[ "$KEEP_RELEASES" =~ ^[0-9]+$ ]] && [ "$KEEP_RELEASES" -ge 2 ] || die "SOG_KEEP_RELEASES must be a number >= 2"
  [[ "$KEEP_BACKUPS" =~ ^[0-9]+$ ]] && [ "$KEEP_BACKUPS" -ge 1 ] || die "SOG_KEEP_BACKUPS must be a number >= 1"
}

# remote ARGS... < script : run a bash script (stdin) on the hub with quoted positional arguments
remote() { "${SSH[@]}" "bash -s -- $(rq "$@")"; }

# upload LOCAL REMOTE_PATH : stream a file over ssh (no scp: its "C:/..." vs host:path parsing
# differs between Git Bash and Windows builds); written to .part and renamed when complete
upload() {
  local src="$1" dst="$2"
  "${SSH[@]}" "cat > $(rq "$dst.part") && mv -f $(rq "$dst.part") $(rq "$dst")" < "$src"
}

# public_release_id : the "sha" field of $PUBLIC_URL/release.json, or "" (curl -k with INSECURE=1)
public_release_id() {
  local k=() body
  [ "${INSECURE:-0}" = 1 ] && k=(-k)
  body=$(curl -fsS "${k[@]}" --max-time 15 -H 'Cache-Control: no-cache' "$PUBLIC_URL/release.json?cb=$RANDOM$RANDOM" 2>/dev/null) || return 0
  body=$(printf '%s' "$body" | tr -d ' \r\n\t')
  [[ "$body" =~ \"sha\":\"([0-9a-f]{12})\" ]] && printf '%s' "${BASH_REMATCH[1]}"
  return 0
}

# public_code PATH : the HTTP status of $PUBLIC_URL/PATH ("000" when there is no answer)
public_code() {
  local k=()
  [ "${INSECURE:-0}" = 1 ] && k=(-k)
  curl -sS "${k[@]}" --max-time 15 -o /dev/null -w '%{http_code}' "$PUBLIC_URL$1" 2>/dev/null || true
}

# wait_public ID : up to ~30 s for the public site to serve release ID and /en/ with 200
wait_public() {
  local want="$1" got="" code="" i
  for i in $(seq 1 15); do
    got=$(public_release_id)
    code=$(public_code /en/)
    if [ "$got" = "$want" ] && [ "$code" = 200 ]; then
      say "public check: $PUBLIC_URL/release.json = $got, /en/ = $code"
      return 0
    fi
    sleep 2
  done
  say "public check FAILED: $PUBLIC_URL/release.json = '${got:-no answer}' (want $want), /en/ = ${code:-000}"
  return 1
}
