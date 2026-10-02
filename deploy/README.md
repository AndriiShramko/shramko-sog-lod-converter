# Deploying the PLY to Shramko SOG LOD Converter

The site is static: the converter runs in the visitor's browser. The hub serves the built files
from `dist/` (written by `npm run build`) and a tiny API (feedback, reports, counters, health). Nothing is built on the hub.
The hub is shared with other services, so these scripts never touch anything that is not ours.

## Settings: `deploy/hub.env`

Everything about the hub (address, SSH port, user, key, paths) lives in `deploy/hub.env`, which is
gitignored. Copy [`hub.env.example`](hub.env.example) and fill it in. The scripts **parse** it
(one `SOG_NAME=value` per line). They never source it, because Git Bash rewrites exported values
that look like paths (`/srv/sog` becomes `C:/Program Files/Git/srv/sog`).

Every hub command below goes through [`hub.sh`](hub.sh), which reads the same file. `$BASE` and
`$BACKUPS` are set for the command:

```bash
bash deploy/hub.sh 'docker ps --filter name=sog-'
bash deploy/hub.sh 'cd "$BASE" && ls -la'
bash deploy/hub.sh                       # interactive shell
```

## What is where on the hub

| Path (`$BASE` = `SOG_BASE`) | What it is |
|---|---|
| `$BASE/compose.yml` | `sog-web` (nginx, static site, on `web-proxy` + `sog-internal`) and `sog-api` (python, `sog-internal` only). No host ports. |
| `$BASE/nginx.conf` | copy of [`nginx.conf`](nginx.conf), mounted read-only into `sog-web` as a single file |
| `$BASE/config.env` | `TG_BOT_TOKEN`, `TG_CHAT_ID` for the API. Secrets: only on the hub, never in git |
| `$BASE/api/` | the API code, mounted read-only at `/app` in `sog-api` |
| `$BASE/data/` | what the API stores (reports, leads, counters) |
| `$BASE/releases/<id>/` | unpacked releases; the newest `SOG_KEEP_RELEASES` (5) are kept, plus the previous live one |
| `$BASE/releases/current` | symlink to the live release; nginx serves `/srv/releases/current` |
| `$BASE/incoming/` | uploads in flight (removed after unpacking) |
| `$SOG_BACKUPS/sog-predeploy-<UTC>-<id>.tgz` | written before every switch; the newest `SOG_KEEP_BACKUPS` (10) are kept |

**The release id** is the `sha` in the build's own `release.json`. `web/scripts/post-build.mjs`
writes it as `{"sha": "<12 hex>", "built": "<time>"}`, and it is a content hash of the build. The
page reads `/release.json`, its error reports carry the same `sha`, and the hub keeps the release
in `releases/<sha>/`. So all three name the same release.

- If a build has no `release.json` with a `sha`, `deploy.sh` computes a content hash itself and
  writes `{"sha", "built", "commit"}`.
- If that id is already on the hub with identical content (`release.json` aside), the existing
  release is kept.
- If that id is already on the hub with different content (a stale `release.json`), the deploy is
  refused before anything changes.

## First deploy (staging certificate first)

Before you start:

- The DNS `A` record for `sog.flyreelstudio.eu` points at the hub.
- The SSH user can run `docker` and can write `SOG_BACKUPS`.
- `dist/` (from `npm run build`) and `api/server.py` exist.

1. **Neighbours before.** `python deploy/neighbours.py snap deploy/snapshots/before-init`
   (`deploy/snapshots/` is gitignored).
2. **Directories and files.** `bash deploy/deploy.sh --init`
   - It refuses if `sog-web` or `sog-api` already exist, or if the external network `web-proxy` is
     missing.
   - It creates `releases/ incoming/ data/ api/`, then copies `compose.yml`,
     `compose.staging.yml`, `nginx.conf` and `api/` (without tests or caches).
   - It does **not** create `config.env`. It prints the command that does.
3. **Secrets.** Run the printed `bash deploy/hub.sh '(umask 077 && grep -E "^(TG_BOT_TOKEN|TG_CHAT_ID)=" ...'`
   line. It copies only those two lines from `SOG_TG_CONFIG_SRC` into `$BASE/config.env` (mode
   600), and prints `2` (the number of lines), never the values.
4. **Start with the Let's Encrypt staging issuer:**
   `bash deploy/hub.sh 'cd "$BASE" && docker compose -f compose.yml -f compose.staging.yml up -d'`.
   Then `bash deploy/hub.sh 'docker ps --filter name=sog-'`: both containers should be up and,
   after about 30 s, `healthy`. `curl -kI https://sog.flyreelstudio.eu/healthz` should answer `200`.
5. **First release:** `bash deploy/deploy.sh --insecure-tls`. The flag lets the public check accept
   the untrusted staging certificate. Use it only now.
6. **Production certificate:**
   `bash deploy/hub.sh 'cd "$BASE" && docker compose -f compose.yml up -d --force-recreate sog-web'`.
   After a few minutes, `curl -sI https://sog.flyreelstudio.eu/en/` must work **without** `-k`.
   Check the issuer with
   `openssl s_client -connect sog.flyreelstudio.eu:443 -servername sog.flyreelstudio.eu </dev/null 2>/dev/null | openssl x509 -noout -issuer`
   (it must not say STAGING). If it still does, read the acme-companion log for `sog`. Never run
   acme-companion's `force_renew`: it renews every neighbour's certificate too.
7. **Neighbours after:** `python deploy/neighbours.py snap deploy/snapshots/after-init`, then
   `python deploy/neighbours.py diff deploy/snapshots/before-init deploy/snapshots/after-init`. Ours (`sog-web`,
   `sog-api`, the `sog-internal` network, the new vhost) are allowed. Anything else means STOP and
   undo (`docker compose down` in `$BASE`, which removes only our two containers and our network).

## Deploying a release

```bash
npm run build                    # writes dist/ and dist/release.json
bash deploy/deploy.sh            # or --check: pack the artifact + read-only preflight, no upload
```

`deploy.sh` stops at the first failed step. Every step prints what it found.

1. **Artifact.** `dist/` is copied without dotfiles, takes its id from `release.json`, and is
   packed into `dist-<id>.tgz` with its sha256.
2. **Preflight (read-only).** `$BASE` exists and `sog-web` is running. There is enough free disk:
   at least 2 GB, and at least 3x the artifact. The hub's `nginx.conf` **and** the copy `sog-web`
   actually sees are byte-identical to `deploy/nginx.conf`. If any of this fails, nothing is
   uploaded.
3. **Upload.** The artifact goes over ssh (no scp) into `incoming/`, then `sha256sum -c` runs on the
   hub. It is unpacked into `releases/<id>/`. A release without `en/index.html` is refused, and so
   is an id already on the hub with different content.
4. **Backup.** `$BASE` is packed without `releases/` and `incoming/`, but with the live release and
   its symlink. No backup means no switch.
5. **Switch.** `ln -sfn` + `mv -T` (an atomic rename), then `nginx -t && nginx -s reload` in
   `sog-web`.
6. **Checks.**
   - Inside `sog-web`, `/release.json` must name the new id, and `/en/` must answer 200 with the
     CSP header.
   - From your machine, `https://sog.flyreelstudio.eu/release.json` must name the new id, and `/en/`
     must answer 200.
   - If either check fails, the previous release is put back. The public check puts it back only
     while `current` is still the new id. On a first deploy there is nothing to put back: the
     release stays, and the script says so.
7. **Pruning.** Old releases and backups beyond the limits are removed, but never the live release
   or the previous one.

A lock (`$BASE/.deploy.lock`) stops two deploys or rollbacks from running at the same time.

## Rolling back

```bash
bash deploy/rollback.sh            # releases on the hub, newest first; * = live
bash deploy/rollback.sh <id>       # switch, nginx -t + reload, check inside sog-web and in public
```

If `nginx -t` fails, or `sog-web` does not serve that id, the release that was live is put back.

**Restoring from a backup** (when `$BASE` itself is damaged):
`bash deploy/hub.sh 'tar -tzf "$BACKUPS"/sog-predeploy-<UTC>-<id>.tgz'` lists what is inside. To
restore, unpack it into `$BASE` with `tar -xzf ... -C "$BASE"`. It holds `compose.yml`,
`nginx.conf`, `config.env`, `api/`, `data/`, `releases/current` and the release `current` pointed
to. Then run `docker restart sog-web sog-api`.

## Changing nginx.conf

```bash
bash deploy/deploy.sh --sync-config
```

This changes the config and deploys `dist/` in one run. Before the release switch it:

1. uploads `deploy/nginx.conf` as `nginx.conf.new`;
2. tests it with `nginx -t` in a throwaway container from `sog-web`'s image, with the same mounts;
3. keeps the live file as `nginx.conf.prev`;
4. writes the new file **in place**: the inode stays the same, so the single-file bind mount sees
   it;
5. runs `nginx -t` inside `sog-web` and reloads.

If the hub file had been replaced earlier (new inode), `sog-web` is restarted instead. Any failure
puts `nginx.conf.prev` back and stops before the switch. The running nginx keeps the config it had
loaded.

Rules the file keeps (they are also comments in [`nginx.conf`](nginx.conf)):

- Every `location` repeats the full security header block. An `add_header` in a location drops the
  server-level set.
- The API is reached through a variable (`proxy_pass $api_upstream...`) with Docker's resolver. That
  way `nginx -t` passes without the API, and a recreated `sog-api` is found again within 10 s.
- The client address comes from the `X-Forwarded-For` value that nginx-proxy appends. It is read
  from the right, and private hops are trusted. The API gets exactly that address in `X-Real-IP`
  and `X-Forwarded-For`, so a forged header changes nothing.
- `/api/stats` answers only to requests from inside `sog-web`:
  `bash deploy/hub.sh 'docker exec sog-web wget -qO- http://127.0.0.1/api/stats'`.

## Changing the API (`api/`)

```bash
bash deploy/deploy.sh --sync-api
```

1. It uploads `api/` (without tests or caches).
2. It parses every `.py` file with the API's own `python:3.12-alpine` in a throwaway container.
3. It keeps the live files in `$BASE/api.prev/`.
4. It copies the new files in place and removes files that are no longer shipped.
5. It restarts `sog-api`. `/api/health` must then answer 200 through `sog-web` within 30 s.
   Otherwise the previous files come back and `sog-api` is restarted again.

`docker restart` does **not** re-read `config.env`. After changing it, recreate the container:
`bash deploy/hub.sh 'cd "$BASE" && docker compose up -d --force-recreate sog-api'`.

## Changing compose.yml (limits, image versions)

1. Keep a copy: `bash deploy/hub.sh 'cp "$BASE/compose.yml" "$BASE/compose.yml.prev"'`.
2. Upload: `bash deploy/hub.sh 'cat > "$BASE/compose.yml"' < deploy/compose.yml`.
3. Recreate: `bash deploy/hub.sh 'cd "$BASE" && docker compose up -d'`. Compose recreates only the
   services whose definition changed.
4. Take neighbour snapshots before and after, as in "First deploy".

## Reading reports and leads

Reports (bugs and ideas from the site) live in `$BASE/data/` on the hub. There is no public URL
that lists them. `tools/reports/pull.py` reads them over SSH with this `hub.env`, through
`deploy/neighbours.py` (`HUB`, `SSH`, `require_hub()`), into `tools/reports/inbox/`. That folder is
gitignored, because it holds visitors' words and contacts.

```bash
python tools/reports/pull.py pull                    # copy the reports from the hub
python tools/reports/pull.py list --kind bug         # open bugs, newest first
python tools/reports/pull.py show R-20261002-0007    # one report and its diagnostics
python tools/reports/pull.py close R-20261002-0007 --note "fixed in <commit>"
```

## Tests (local, no hub)

| Script | What it proves |
|---|---|
| [`tests/nginx.sh`](tests/nginx.sh) | It runs `nginx -t` on this `nginx.conf` in `nginx:1.29-alpine`, then serves a fake release (behind a symlink) with a fake `sog-api`. It checks: the language redirect (cookie, Accept-Language, query string kept); `/en/` with the exact enforced CSP; the security headers on every kind of response; `.wasm` served as `application/wasm`, immutable and gzipped; dotfiles answering 404; a symlink switch without a reload; the proxy (the real client address, no cookies, body limits, methods); `/api/stats` refused even with a forged `X-Forwarded-For: 127.0.0.1`; the API found again after it is recreated with a new address. |
| [`tests/fakehub.sh`](tests/fakehub.sh) | It runs `deploy.sh`, `rollback.sh` and `hub.sh` end to end against a fake hub. That is a local container running the real nginx and this config, plus a `docker` stub; `ssh` is replaced by `docker exec`. It covers: `--init`, then a refused second `--init`; the printed `config.env` command; first, repeat and second deploys; the nginx.conf guard; `--sync-config`, including a broken config; a failed internal check and a failed public check (each puts the previous release back); the lock; pruning; rollback (listing, switching, unknown ids); `--sync-api` (success, a parse error, a failed health check that puts the previous files back); bad `hub.env` files; `--check` making no changes. |

Both need Docker and curl. Run them with `bash deploy/tests/nginx.sh` and
`bash deploy/tests/fakehub.sh`.

**Not yet run against the real hub:** everything above was proven locally only. The first real run
is the "First deploy" section.
