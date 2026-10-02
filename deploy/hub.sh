#!/usr/bin/env bash
# Run one command on the hub with the settings from deploy/hub.env (parsed, never sourced), or open
# a shell there. Used by the runbook in deploy/README.md.
#   bash deploy/hub.sh                                   # interactive shell
#   bash deploy/hub.sh 'docker ps --filter name=sog-'    # one command (one quoted argument)
# The variables BASE and BACKUPS of hub.env are set for the command: 'cd "$BASE" && ls'.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

load_hub_env "${SOG_HUB_ENV:-$HERE/hub.env}"
hub_setup

if [ $# -eq 0 ]; then
  exec ssh -t "${SSH_OPTS[@]}" "$SOG_HOST"
fi
[ $# -eq 1 ] || die "pass the remote command as ONE quoted argument"
exec "${SSH[@]}" "BASE=$(rq "$BASE") BACKUPS=$(rq "$BACKUPS"); $1"
