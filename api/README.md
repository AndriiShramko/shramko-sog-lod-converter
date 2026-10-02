# sog-api

A tiny API next to the static converter at https://sog.flyreelstudio.eu. The conversion runs
entirely in the visitor's browser; this process only receives feedback, cooperation requests,
automatic error reports and anonymous usage counts. One file, Python 3.12 standard library only
(`server.py`), run as `python -u /app/server.py` in a `python:3.12-alpine` container (`sog-api`)
behind the site's nginx (`sog-web`).

## Endpoints

| Method + path | Body | Answer |
|---|---|---|
| `GET /api/health` | none | `200 {"ok":true,"site":"sog"}`; `503 {"ok":false,"reason":"disk"}` when the disk guard has tripped |
| `POST /api/report` | JSON, plain or `Content-Encoding: gzip`, at most 512 KB on the wire and 2 MB unpacked | `200 {"ok":true,"id":"R-20261002-0001","diagnostics":true\|false\|"skipped","delivered":bool}` |
| `POST /api/lead` | JSON, at most 8 KB | `200 {"ok":true,"id":"L-20261002-1a2b3c4d","delivered":bool}` |
| `POST /api/e` | JSON, at most 8 KB (`navigator.sendBeacon` is fine) | `204` |
| `GET /api/stats?days=30` | none | `200 {"ok":true,"site":"sog","days":{"2026-10-02":{"counts":{...},"props":{...}}}}`; only from 127.0.0.1 |

Errors: `400` bad input, `413` too large, `415` an encoding other than gzip, `429` rate limit,
`500` could not store (then nothing is sent to Telegram either). `delivered` says whether the
Telegram note went out; it is `false` for suspects, repeats, or when no bot token is configured.

### `POST /api/report`

```json
{"kind": "bug", "message": "...", "contact": "@me or e-mail (optional)",
 "page": "convert", "lang": "en", "release": "1a2b3c4", "stage": "lod",
 "t": 8200, "website": "",
 "diagnosticsConsent": true, "diagnostics": {"stack": "...", "gpu": {...}, "input": {...}}}
```

- `kind`: `bug` or `idea` (typed by a person: `message` required, at most 2000 characters,
  `contact` at most 200) or `error` (sent by the converter itself when a conversion fails: the
  message is generated, no contact).
- `page`, `stage`: slugs `[a-z0-9][a-z0-9_.-]{0,39}`; `lang` (or `locale`): `en`, `pt-BR`...;
  `release`: `[0-9A-Za-z._-]{1,40}`. Anything else is stored as empty.
- Spam: a non-empty honeypot `website` makes any report a suspect; for `bug` and `idea` so does a
  time-to-submit `t` under 3000 ms (errors are exempt). A suspect is stored, never announced and
  never keeps diagnostics; the answer looks the same as for anyone else.
- Diagnostics are stored only for `bug` and `error`, and only with `diagnosticsConsent: true`
  (the JSON boolean). For errors the UI shows a visible, pre-ticked checkbox "send anonymous
  error reports" that the visitor can untick; unticked means `false` and no diagnostics.
  Kept top-level keys: `release stage error errorName stack errors log userAgent browser os
  platform language screen online hardwareConcurrency deviceMemory jsHeap storage
  crossOriginIsolated gpu webgpu input options timings progress output save`. At any depth,
  keys named `name filename file path fullPath webkitRelativePath url href email contact cookie(s)
  token ip` are removed; depth 8, 500 items a list, 4000 characters a string. The page should
  never put file names or local paths into a generated error message either.
- Errors are de-duplicated for Telegram: the same `(release, stage, message)` (digits in the
  message ignored) within 24 h of its first report is stored in full with `repeatOf: <first id>`
  but not announced. Once a UTC day one line lists how many repeats each announced error had.
  The state lives in `errors-seen.json`, so a restart does not announce again.

### `POST /api/lead`

```json
{"role": "scanner", "email": "a@b.example", "name": "optional", "message": "at most 1000",
 "consent": true, "lang": "en", "page": "cooperate", "t": 9000, "website": ""}
```

`role`: `scanner | studio | developer | platform | investor | other` (anything else becomes
`other`). A valid e-mail and `consent: true` are required (else `400`). Honeypot and `t` as for
reports. Telegram: `[LEAD][site=sog][type=<role>] <id>`.

### `POST /api/e`

`{"e": "convert_done", "p": "1g-4g"}` (or `"p": {"size": "1g-4g"}`). An unknown name is `400`;
a value off its list is dropped and the event still counts.

| Event | Optional value |
|---|---|
| `page_view`, `lang_switch` | `lang`: two letters |
| `file_selected`, `convert_start`, `convert_done` | `size`: `lt100m 100m-1g 1g-4g 4g-16g 16g-64g gt64g` (input PLY size) |
| `convert_error`, `convert_cancel` | `stage`: slug |
| `save_fallback` | `method`: slug |
| `gpu_unavailable` | `reason`: slug |
| `feedback_open`, `lead_submit` | none |

Only daily totals are kept (at most 32 distinct values per event and day, the rest count as
`other`), in memory and written to `events-YYYY-MM-DD.json` every minute and on shutdown.

## Rate limits and the client address

Per client: reports 10/h (bug + idea), errors 20/h, all report requests 40/h (checked before the
body is read), leads 8/h, events 600/h. Global caps: reports 300/h, errors 1000/h, report
requests 2000/h, leads 100/h, events 60000/h.

The client is taken from `X-Real-IP`, else the **last** `X-Forwarded-For` entry, else the socket
peer (IPv6 grouped by /64). Our nginx must resolve the real address and overwrite both headers,
so a visitor's own `X-Forwarded-For` cannot rotate the key (the ShramkoGSFPV API took the first
entry, which the visitor controls). `deploy/nginx.conf` is the real config; this is the minimum
the API relies on (checked with `nginx -t` and end to end in nginx:1.29-alpine + the API):

```nginx
# server level: trust only the hub's docker ranges (nginx-proxy) and walk X-Forwarded-For from the right
set_real_ip_from 10.0.0.0/8;
set_real_ip_from 172.16.0.0/12;
set_real_ip_from 192.168.0.0/16;
set_real_ip_from 127.0.0.1;
real_ip_header X-Forwarded-For;
real_ip_recursive on;

set $api_upstream http://sog-api:8090;
location = /api/report {
    limit_except POST { deny all; }
    proxy_pass $api_upstream/api/report;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;   # overwrite, never $proxy_add_x_forwarded_for
    client_max_body_size 512k;
}
location = /api/lead { limit_except POST { deny all; } proxy_pass $api_upstream/api/lead;
    proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $remote_addr; client_max_body_size 8k; }
location = /api/e    { limit_except POST { deny all; } proxy_pass $api_upstream/api/e;
    proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $remote_addr; client_max_body_size 8k; }
location = /api/health { proxy_pass $api_upstream/api/health; }
location = /api/stats {
    allow 127.0.0.1; deny all;
    if ($realip_remote_addr != "127.0.0.1") { return 403; }  # the socket itself, not a header
    proxy_pass $api_upstream/api/stats$is_args$args;           # keeps ?days=N
    proxy_set_header X-Real-IP $remote_addr;
}
```

The API checks `/api/stats` again: it answers `403` when `X-Real-IP` or any `X-Forwarded-For`
entry is not a loopback address. Read it on the hub with
`docker exec sog-web wget -qO- http://127.0.0.1/api/stats?days=7`.

Memory: each limiter keeps at most `RATE_MAX_KEYS` (10000) keys, about 2.4 MB at the cap
(measured), and forgets a key after two idle windows; fits the 64 MB container.

## Environment

| Variable | Default | |
|---|---|---|
| `PORT` | `8090` | |
| `DATA_DIR` | `/data` | the mounted data volume |
| `SITE_TAG` | `sog` | the `[site=...]` tag in Telegram |
| `TG_BOT_TOKEN`, `TG_CHAT_ID` | unset | from the server's `config.env` only, never in git; unset = nothing is sent (`delivered:false`) |
| `MIN_FREE_GB` | `2` | disk guard: below it, diagnostics and event files pause, `/api/health` is 503, one warning goes to Telegram |
| `REPORTS_CAP_BYTES` | 1 GiB | `reports/` cap: past it diagnostics are `"skipped"`, the record is still stored |
| `REPORT_RETENTION_DAYS` | `180` | diagnostics files are deleted after this |
| `EVENTS_RETENTION_DAYS` | `400` | daily totals are deleted after this |
| `RATE_MAX_KEYS` | `10000` | per rate limiter |
| `API_DEBUG` | unset | print tracebacks of failed requests |

## Data layout (`DATA_DIR`)

```
reports.jsonl            one line per report: id, ts, kind, page, lang, release, stage, message,
                         contact, suspect, diagnostics (true|false|"skipped"), diagBytes, repeatOf
reports/R-YYYYMMDD-NNNN.json   diagnostics of one report (consent only)
errors-seen.json         error de-duplication state and the daily count line
leads.jsonl              one line per cooperation request
events-YYYY-MM-DD.json   {"day","site","counts":{event:n},"props":{event:{value:n}}}
```

Writes are durable: a record is fsynced (diagnostics file first, then the line) before Telegram
is called. Retention: diagnostics 180 days, daily totals 400 days (checked hourly).
`reports.jsonl` and `leads.jsonl` are small and kept until the owner removes them.

## Privacy

- No IP address is stored or logged anywhere. It is used only as an in-memory rate-limit key.
- Logs: time, method, path without the query string, status. The default server error lines,
  which carry the client address, are replaced.
- No cookies, no device or user ids. Events are totals per day, never single events.
- Diagnostics only with the visitor's explicit consent flag, whitelisted and scrubbed; Telegram
  never gets them, only the id, page, lang, release, stage and the first 600 characters of the message.
- Contact details are only what a visitor typed into the bug/idea form or the cooperation form.

## How the agent reads reports

There is no public URL that lists reports. `tools/reports/pull.py` reads them over SSH, using
`deploy/hub.env` (gitignored; `SOG_HOST SOG_PORT SOG_USER SOG_KEY SOG_BASE`), into the gitignored
`tools/reports/inbox/`:

```
python tools/reports/pull.py pull
python tools/reports/pull.py list --kind error
python tools/reports/pull.py show R-20261002-0007
python tools/reports/pull.py close R-20261002-0007 --note "fixed in 1a2b3c4"
python tools/reports/pull.py stats --days 30
python tools/reports/pull.py --selftest        # no SSH
```

## Tests

```
python -m unittest discover -s api/tests -v
```

Standard library only, no network: a real server on a free port with a temporary `DATA_DIR`,
Telegram replaced by a recorder, plus one case that starts `python api/server.py` as a process.
