#!/usr/bin/env bash
# Server-side snapshot of the shared hub, run over SSH by deploy/neighbours.py before and after a
# deploy. Read-only towards every container; writes only into <out_dir>.
# Usage: bash snapshot-server.sh <out_dir>
# Writes plain-text files + SHA256SUMS, verifies them, archives <out_dir>.tgz and lists the archive.
set -euo pipefail
OUT="${1:?out dir}"
mkdir -p "$OUT"
cd "$OUT"
docker ps -a --format '{{.Names}}|{{.Image}}|{{.Status}}' | sort > containers.txt
for c in $(docker ps -a --format '{{.Names}}' | sort); do
  docker inspect -f '{{.Name}}|{{.State.StartedAt}}|{{.RestartCount}}' "$c" 2>/dev/null | sed 's#^/##' || true
done > started.txt
: > vhosts.txt
for c in $(docker ps --format '{{.Names}}' | sort); do
  hosts=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$c" 2>/dev/null | sed -n 's#^VIRTUAL_HOST=##p' | tr ',' '\n' || true)
  for h in $hosts; do echo "$c|$h" >> vhosts.txt; done
done
sort -u -o vhosts.txt vhosts.txt
docker exec nginx-proxy cat /etc/nginx/conf.d/default.conf > nginx-proxy-default.conf 2>/dev/null || echo "unavailable" > nginx-proxy-default.conf
ss -ltn | awk 'NR>1 {print $4}' | sort -u > listening.txt
df -h / > df.txt
docker system df > docker-df.txt 2>&1 || true
docker network ls --format '{{.Name}}|{{.Driver}}' | sort > networks.txt
date -u +%Y-%m-%dT%H:%M:%SZ > taken_at.txt
sha256sum containers.txt started.txt vhosts.txt nginx-proxy-default.conf listening.txt df.txt docker-df.txt networks.txt taken_at.txt > SHA256SUMS
sha256sum -c SHA256SUMS > /dev/null
tar czf ../"$(basename "$OUT")".tgz -C .. "$(basename "$OUT")"
tar tzf ../"$(basename "$OUT")".tgz > /dev/null
echo "$OUT OK"
