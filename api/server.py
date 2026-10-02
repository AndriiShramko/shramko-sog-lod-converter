"""PLY to Shramko SOG LOD Converter API (site tag "sog"): tiny, stdlib only, no framework.

The converter itself runs entirely in the visitor's browser; this process only takes what the page
sends back about it. Routes (behind our nginx, see api/README.md for the expected config):

GET  /api/health  200 {"ok": true, "site": "sog"}; 503 when the disk guard has tripped.
POST /api/report  a bug or an idea typed by a visitor, or an error the converter sends by itself when
                  a conversion fails. Stored FIRST (reports.jsonl, fsync, id R-YYYYMMDD-NNNN numbered
                  per UTC day), then a short Telegram note (never the diagnostics). Diagnostics (the
                  technical details the page collected) only with diagnosticsConsent: true, whitelisted
                  and scrubbed, kept apart in reports/<id>.json; the only large body (512 KB on the
                  wire, gzip accepted, unpacked to at most 2 MB). The same error (release, stage,
                  message) within 24 h is stored again but announced once, plus one count line a day.
POST /api/lead    the cooperation form: stored to leads.jsonl (fsync), then Telegram.
POST /api/e       cookieless first-party counter: allow-listed event names (and a few allow-listed
                  values), kept only as daily totals in events-YYYY-MM-DD.json. No IP, no user id,
                  no per-event lines.
GET  /api/stats   the daily totals; nginx lets only 127.0.0.1 in, and the API checks it again.

Privacy: no client address is stored or logged. It is used only as a key of the in-memory rate
limiters, which forget it within two windows and never hold more than MAX_KEYS keys each.
Secrets (TG_BOT_TOKEN, TG_CHAT_ID) come from the environment only (config.env on the server, never
in git). Logs: time, method, path (no query) and status, nothing else.
"""
from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import re
import shutil
import signal
import sys
import threading
import time
import traceback
import unicodedata
import urllib.parse
import urllib.request
import uuid
import zlib
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SITE = os.environ.get("SITE_TAG", "sog")
DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
MIN_FREE_GB = float(os.environ.get("MIN_FREE_GB", "2"))
REPORTS_CAP_BYTES = int(os.environ.get("REPORTS_CAP_BYTES", str(1024 * 1024 * 1024)))   # reports/ directory
REPORT_RETENTION_DAYS = int(os.environ.get("REPORT_RETENTION_DAYS", "180"))           # diagnostics files
EVENTS_RETENTION_DAYS = int(os.environ.get("EVENTS_RETENTION_DAYS", "400"))           # daily totals
MAX_KEYS = int(os.environ.get("RATE_MAX_KEYS", "10000"))  # per rate limiter, ~300 bytes each

MAX_BODY = 8 * 1024               # a lead, an event, a report without its diagnostics
MAX_UPLOAD = 512 * 1024           # a report with diagnostics, on the wire (nginx: client_max_body_size 512k)
MAX_INFLATED = 2 * 1024 * 1024    # a gzip body unpacks to at most this
TELEGRAM_MESSAGE_MAX = 600        # the first characters of a report's message that go to Telegram
DEDUP_WINDOW = 24 * 3600          # the same error is announced once in this window

# Rate limits: (hits, window in seconds) per client, and for everyone together ("global caps").
LIMITS = {
    "report_any": (40, 3600),    # every /api/report request, before its body is read (>= report + error)
    "report": (10, 3600),        # bug + idea (typed by a person)
    "error": (20, 3600),         # errors the converter sends by itself
    "lead": (8, 3600),
    "event": (600, 3600),
}
GLOBAL_LIMITS = {
    "report_any": (2000, 3600),
    "report": (300, 3600),
    "error": (1000, 3600),
    "lead": (100, 3600),
    "event": (60000, 3600),
}


def reports_file() -> Path:
    return DATA_DIR / "reports.jsonl"


def reports_dir() -> Path:
    return DATA_DIR / "reports"         # <id>.json: diagnostics, only with consent


def leads_file() -> Path:
    return DATA_DIR / "leads.jsonl"


def dedup_file() -> Path:
    return DATA_DIR / "errors-seen.json"  # error dedup state, so a restart does not announce again


def events_file(day: str) -> Path:
    return DATA_DIR / f"events-{day}.json"


def utc_day(now: float, fmt: str = "%Y-%m-%d") -> str:
    return time.strftime(fmt, time.gmtime(now))


def utc_ts(now: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))


# ---------------- rate limits: bounded memory ----------------

class RateLimiter:
    """At most `limit` hits per `window` seconds per key, in O(1) memory per key.

    Each key keeps [start of its current window, hits in it, hits in the previous window]; the count
    is the usual sliding-window estimate prev * (1 - elapsed / window) + cur (exact while there is no
    previous window). A refused hit is not counted. Unlike a list of timestamps per key (the gsfpv
    API), the memory does not grow with the limit, keys idle for two windows are swept, and the map
    never holds more than max_keys keys: the least recently seen key is dropped first.
    """

    def __init__(self, limit: int, window: float, max_keys: int = MAX_KEYS):
        self.limit, self.window, self.max_keys = limit, float(window), max_keys
        self._keys: OrderedDict[str, list] = OrderedDict()
        self._lock = threading.Lock()
        self._next_sweep = 0.0

    def __len__(self) -> int:
        return len(self._keys)

    def _roll(self, e: list, now: float) -> None:
        periods = int((now - e[0]) // self.window)
        if periods >= 1:
            e[2] = e[1] if periods == 1 else 0
            e[1] = 0
            e[0] += periods * self.window

    def sweep(self, now: float) -> None:
        """Forget every key with no hit in its current or previous window (caller holds _lock)."""
        for k in [k for k, e in self._keys.items() if now - e[0] >= 2 * self.window]:
            del self._keys[k]
        self._next_sweep = now + min(60.0, self.window / 10)

    def hit(self, key: str, now: float | None = None) -> bool:
        now = time.time() if now is None else now
        with self._lock:
            if now >= self._next_sweep:
                self.sweep(now)
            e = self._keys.get(key)
            if e is None:
                while len(self._keys) >= self.max_keys:
                    self._keys.popitem(last=False)
                e = self._keys[key] = [now, 0, 0]
            else:
                self._keys.move_to_end(key)
                self._roll(e, now)
            weight = max(0.0, 1.0 - (now - e[0]) / self.window)
            if e[2] * weight + e[1] + 1 > self.limit:
                return False
            e[1] += 1
            return True


def client_key(headers, peer: str) -> str:
    """The visitor's address as OUR nginx (sog-web) hands it over, for the rate limiters only.

    Our nginx resolves the real address with the real-IP module (trusting only the hub's docker
    ranges, real_ip_recursive on) and then OVERWRITES both headers: X-Real-IP $remote_addr and
    X-Forwarded-For $remote_addr. So X-Real-IP comes first; failing that the LAST X-Forwarded-For
    entry (the one the nearest proxy appended; the first entries are whatever the client typed:
    the gsfpv API took the first one, which a visitor could change on every request); failing that
    the socket peer. IPv6 addresses are grouped by /64, so one host cannot rotate through its prefix.
    """
    for raw in (headers.get("X-Real-IP"), (headers.get("X-Forwarded-For") or "").split(",")[-1], peer):
        try:
            ip = ipaddress.ip_address((raw or "").strip())
        except ValueError:
            continue
        if ip.version == 6 and ip.ipv4_mapped:
            ip = ip.ipv4_mapped
        if ip.version == 6:
            return str(ipaddress.ip_network(f"{ip}/64", strict=False))
        return str(ip)
    return "?"


def _is_loopback(raw: str | None) -> bool:
    try:
        return ipaddress.ip_address((raw or "").strip()).is_loopback
    except ValueError:
        return False


# ---------------- state ----------------

class State:
    """Everything the process keeps in memory, in one place (tests start a fresh one per case)."""

    def __init__(self):
        self.lock = threading.RLock()                  # every file write and every counter below
        self.seq = {"day": "", "n": 0, "file": None}   # report ids of the current UTC day
        self.dir_bytes: dict[str, int] = {}            # bytes in reports/, counted once, then added
        self.guard = {"tripped": False, "warned": False}
        self.errors: dict | None = None                # error dedup state, read lazily from disk
        self.events = EventCounts()
        self.limits = {k: RateLimiter(*v) for k, v in LIMITS.items()}
        self.global_limits = {k: RateLimiter(*v, max_keys=1) for k, v in GLOBAL_LIMITS.items()}

    def allow(self, name: str, client: str) -> bool:
        """A hit for this client and for everyone; refused when either is over its limit."""
        return self.limits[name].hit(client) and self.global_limits[name].hit("*")


def reset_state() -> None:
    global S
    S = State()


# ---------------- small helpers ----------------

class BadBody(ValueError):
    """A request refused for its body: the HTTP status to answer with."""

    def __init__(self, status: int):
        super().__init__(str(status))
        self.status = status


def free_gb() -> float:
    try:
        return shutil.disk_usage(DATA_DIR if DATA_DIR.exists() else "/").free / 1e9
    except OSError:
        return 0.0


def send_telegram(text: str) -> int | None:
    """The owner's bot (the shared lead bot). Returns the message id, or None when not delivered:
    no token configured (tests, local runs), Telegram down, or any error (swallowed)."""
    token = os.environ.get("TG_BOT_TOKEN", "")
    chat = os.environ.get("TG_CHAT_ID", "")
    if not token or not chat:
        return None
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=json.dumps({"chat_id": chat, "text": text, "disable_web_page_preview": True}).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            resp = json.load(r)
            return resp.get("result", {}).get("message_id") if resp.get("ok") else None
    except Exception:  # noqa: BLE001
        return None


def check_disk() -> None:
    tripped = free_gb() < MIN_FREE_GB
    S.guard["tripped"] = tripped
    if tripped and not S.guard["warned"]:
        S.guard["warned"] = True
        send_telegram(f"[WARN][site={SITE}] disk guard: {free_gb():.2f} GB free < {MIN_FREE_GB} GB; "
                      "diagnostics and event files paused, /api/health answers 503")
    if not tripped:
        S.guard["warned"] = False


def _plain(v, n: int, lines: bool = False) -> str:
    """A visitor's text: a string only, control and format characters dropped (new lines kept where
    `lines`), trimmed, at most n characters."""
    if not isinstance(v, str):
        return ""
    keep = "\n" if lines else ""
    s = "".join(c for c in v[: n * 2] if c in keep or unicodedata.category(c) not in ("Cc", "Cs", "Cf"))
    return s.strip()[:n].strip()


def _match(rx: re.Pattern, v) -> str:
    return v if isinstance(v, str) and rx.fullmatch(v) else ""


def gunzip_bounded(raw: bytes, limit: int) -> bytes:
    """A gzip body unpacked to at most `limit` bytes: a small bomb cannot fill the 64 MB container."""
    d = zlib.decompressobj(16 + zlib.MAX_WBITS)
    try:
        out = d.decompress(raw, limit + 1)
    except zlib.error as e:
        raise BadBody(400) from e
    if len(out) > limit:
        raise BadBody(413)
    if not d.eof:  # cut short
        raise BadBody(400)
    return out


def _write_durable(path: Path, data: bytes) -> None:
    """Whole file or nothing: a temporary file, fsync, then the rename."""
    tmp = path.with_name(path.name + ".tmp")
    with tmp.open("wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _append_durable(path: Path, rec: dict) -> None:
    """One JSON line appended and fsynced (LF on every platform)."""
    with path.open("a", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        f.flush()
        os.fsync(f.fileno())


def _dir_room(d: Path, n: int, cap: int) -> bool:
    """Room for n more bytes under the directory's cap (caller holds S.lock). Counted from the disk
    the first time, then as files are written."""
    k = str(d)
    if k not in S.dir_bytes:
        S.dir_bytes[k] = sum(f.stat().st_size for f in d.iterdir() if f.is_file()) if d.exists() else 0
    return S.dir_bytes[k] + n <= cap


# ---------------- reports: bug, idea, error ----------------

REPORT_KINDS = ("bug", "idea", "error")
DIAG_KINDS = ("bug", "error")         # an idea never keeps diagnostics
REPORT_MESSAGE_MAX = 2000
REPORT_CONTACT_MAX = 200
SLUG_RE = re.compile(r"[a-z0-9][a-z0-9_.-]{0,39}")          # page, stage
LANG_RE = re.compile(r"[a-z]{2}(?:-[A-Za-z]{2})?")
RELEASE_RE = re.compile(r"[0-9A-Za-z._-]{1,40}")
_REPORT_LINE_RE = re.compile(r'^\{"id": "R-([0-9]{8})-([0-9]{4,})"')
REPORT_ID_RE = re.compile(r"R-[0-9]{8}-[0-9]{4,}")

# Diagnostics: only these top-level keys are kept (the page's contract, api/README.md). Anything that
# could name the visitor or their files is removed at every depth, whatever the page sends.
DIAG_KEYS = {
    "release", "stage", "error", "errorName", "stack", "errors", "log",
    "userAgent", "browser", "os", "platform", "language", "screen", "online",
    "hardwareConcurrency", "deviceMemory", "jsHeap", "storage", "crossOriginIsolated",
    "gpu", "webgpu", "input", "options", "timings", "progress", "output", "save",
}
DIAG_DROP = {"name", "filename", "file", "path", "fullpath", "webkitrelativepath", "url", "href",
             "email", "contact", "cookie", "cookies", "token", "ip"}
DIAG_DEPTH, DIAG_LIST, DIAG_STR = 8, 500, 4000


def _scrub(v, depth: int = 0):
    """A diagnostics value with the dropped keys removed, depth/lists/strings bounded."""
    if depth > DIAG_DEPTH:
        return None
    if isinstance(v, dict):
        return {str(k)[:64]: _scrub(x, depth + 1) for k, x in list(v.items())[:200]
                if str(k).lower().replace("_", "").replace("-", "") not in DIAG_DROP}
    if isinstance(v, list):
        return [_scrub(x, depth + 1) for x in v[:DIAG_LIST]]
    if isinstance(v, str):
        return v[:DIAG_STR]
    if isinstance(v, (bool, int, float)) or v is None:
        return v
    return None


def clean_diagnostics(d) -> dict | None:
    if not isinstance(d, dict):
        return None
    out = {k: _scrub(v, 1) for k, v in d.items() if k in DIAG_KEYS}
    return out or None


def parse_report(b: dict) -> dict:
    """The whitelist of a report. Diagnostics are kept only for a bug or an error whose sender has
    diagnosticsConsent: true; without it they are dropped here and never touch the disk.

    bug / idea: typed by a person; message required; time-to-submit t >= 3000 ms, else suspect.
    error:      sent by the converter itself; its message is generated; exempt from the time check.
    All kinds:  a filled honeypot field "website" makes the report suspect (kept, never announced,
                never with diagnostics)."""
    kind = b.get("kind")
    if kind not in REPORT_KINDS:
        raise BadBody(400)
    message = _plain(b.get("message"), REPORT_MESSAGE_MAX, lines=True)
    if not message:
        raise BadBody(400)
    # everything but the diagnostics: the size of a lead
    if len(json.dumps({k: v for k, v in b.items() if k != "diagnostics"}, ensure_ascii=False).encode()) > MAX_BODY:
        raise BadBody(413)
    try:
        t_ms = float(b.get("t") or 0)
    except (TypeError, ValueError):
        t_ms = 0
    suspect = bool(b.get("website")) or (kind != "error" and t_ms < 3000)
    consent = b.get("diagnosticsConsent") is True
    diag = clean_diagnostics(b.get("diagnostics")) if kind in DIAG_KINDS and consent else None
    return {
        "kind": kind,
        "page": _match(SLUG_RE, b.get("page")),
        "lang": _match(LANG_RE, b.get("lang") or b.get("locale")),
        "release": _match(RELEASE_RE, b.get("release")),
        "stage": _match(SLUG_RE, b.get("stage")),
        "message": message,
        "contact": "" if kind == "error" else _plain(b.get("contact"), REPORT_CONTACT_MAX),
        "suspect": suspect,
        "diagnostics": diag,
    }


def _next_report_id(now: float) -> str:
    """R-YYYYMMDD-NNNN, numbered per UTC day (caller holds S.lock); after a restart the day's last
    number is read back from reports.jsonl."""
    day = utc_day(now, "%Y%m%d")
    if S.seq["day"] != day or S.seq["file"] != reports_file():
        n = 0
        if reports_file().exists():
            with reports_file().open(encoding="utf-8") as f:
                for line in f:
                    m = _REPORT_LINE_RE.match(line)
                    if m and m.group(1) == day:
                        n = max(n, int(m.group(2)))
        S.seq.update(day=day, n=n, file=reports_file())
    S.seq["n"] += 1
    return f"R-{day}-{S.seq['n']:04d}"


# ---- error dedup: the same failure from many visitors is one Telegram message ----

def error_key(r: dict) -> str:
    """(release, stage, message hash); digits in the message do not count (sizes, counts, offsets)."""
    norm = re.sub(r"\s+", " ", re.sub(r"[0-9]+", "#", r["message"])).strip()
    return hashlib.sha256(f"{r['release']}\n{r['stage']}\n{norm}".encode()).hexdigest()[:24]


def _errors() -> dict:
    """The dedup state (caller holds S.lock), read once from errors-seen.json.

    seen:    key -> {first, at, release, stage, msg, n}: the first report of an error in its 24 h
             window; a later one inside the window only counts here and in pending.
    pending: key -> {first, release, stage, msg, n}: repeats not yet in a daily count line.
    digestDay: the UTC day the last count line covered up to."""
    if S.errors is None:
        st = {"digestDay": "", "seen": {}, "pending": {}, "overflow": 0}
        try:
            loaded = json.loads(dedup_file().read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                for k in ("seen", "pending"):
                    if isinstance(loaded.get(k), dict):
                        st[k] = {key: e for key, e in loaded[k].items() if isinstance(e, dict)}
                st["digestDay"] = str(loaded.get("digestDay") or "")
                st["overflow"] = int(loaded.get("overflow") or 0)
        except (OSError, ValueError, TypeError):
            pass
        S.errors = st
    return S.errors


def _save_errors() -> None:
    """Best effort: the reports themselves are already stored; a failed save only means a restart
    may announce an error once more."""
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        _write_durable(dedup_file(), json.dumps(S.errors, ensure_ascii=False, separators=(",", ":")).encode())
    except OSError:
        pass


def _note_error(r: dict, rid: str, now: float) -> str:
    """Records an error in the dedup state (caller holds S.lock, the report is already stored).
    Returns the id of the first report of the same error in the last 24 h, or "" for a first one."""
    st = _errors()
    seen = st["seen"]
    for k in [k for k, e in seen.items() if now - float(e.get("at", 0)) >= DEDUP_WINDOW]:
        del seen[k]
    key = error_key(r)
    e = seen.get(key)
    if e is not None:
        e["n"] = int(e.get("n", 1)) + 1
        p = st["pending"].get(key)
        if p is None and len(st["pending"]) >= 500:
            st["overflow"] += 1
        else:
            if p is None:
                p = st["pending"][key] = {k: e.get(k, "") for k in ("first", "release", "stage", "msg")} | {"n": 0}
            p["n"] += 1
        first = e["first"]
    else:
        while len(seen) >= 5000:
            del seen[min(seen, key=lambda k: seen[k]["at"])]
        seen[key] = {"first": rid, "at": now, "release": r["release"], "stage": r["stage"],
                     "msg": r["message"][:120], "n": 1}
        first = ""
    if not st["digestDay"]:
        st["digestDay"] = utc_day(now)
    _save_errors()
    return first


def error_digest(now: float | None = None) -> str | None:
    """The daily count line: once per UTC day, the errors that repeated since the last one (each was
    announced once already). Returns the Telegram text, or None when there is nothing to say."""
    now = time.time() if now is None else now
    today = utc_day(now)
    with S.lock:
        st = _errors()
        if st["digestDay"] == today:
            return None
        covered, pending, overflow = st["digestDay"], st["pending"], st["overflow"]
        st.update(digestDay=today, pending={}, overflow=0)
        _save_errors()
    if not covered or (not pending and not overflow):
        return None
    total = sum(int(p["n"]) for p in pending.values()) + overflow
    rows = sorted(pending.values(), key=lambda p: -int(p["n"]))
    lines = [f"[ERROR][site={SITE}] repeats up to {covered}: {total} more report(s) of {len(pending)} error(s) already announced"]
    for p in rows[:15]:
        lines.append(f"{p['first']} x{p['n']} release={p['release'] or '-'} stage={p['stage'] or '-'}: {p['msg'][:80]}")
    if len(rows) > 15 or overflow:
        lines.append(f"... and {max(0, len(rows) - 15)} more error(s), {overflow} uncounted")
    return "\n".join(lines)


def store_report(r: dict, now: float | None = None) -> dict:
    """Stored before anything is sent: the diagnostics file first (so a record never names a missing
    file), then the record line, both fsynced; then, for an error, the dedup state. A suspect report
    keeps no diagnostics; a full disk (the guard or the directory's cap) keeps the record and says the
    diagnostics were skipped."""
    now = time.time() if now is None else now
    diag = r["diagnostics"]
    with S.lock:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        rid = _next_report_id(now)
        rec = {"id": rid, "ts": utc_ts(now), "site": SITE,
               **{k: v for k, v in r.items() if k != "diagnostics"}, "diagnostics": False, "diagBytes": 0}
        if diag is not None and not r["suspect"]:
            blob = json.dumps({"id": rid, "ts": rec["ts"], "kind": r["kind"], "diagnostics": diag},
                              ensure_ascii=False, separators=(",", ":")).encode()
            if S.guard["tripped"] or not _dir_room(reports_dir(), len(blob), REPORTS_CAP_BYTES):
                rec["diagnostics"] = "skipped"
            else:
                reports_dir().mkdir(parents=True, exist_ok=True)
                _write_durable(reports_dir() / f"{rid}.json", blob)
                S.dir_bytes[str(reports_dir())] += len(blob)
                rec["diagnostics"], rec["diagBytes"] = True, len(blob)
        if r["kind"] == "error" and not r["suspect"]:
            # decided before the line is written so the record says it, committed after it
            e = _errors()["seen"].get(error_key(r))
            rec["repeatOf"] = e["first"] if e and now - float(e.get("at", 0)) < DEDUP_WINDOW else ""
        _append_durable(reports_file(), rec)
        if r["kind"] == "error" and not r["suspect"]:
            rec["repeatOf"] = _note_error(r, rid, now)
    return rec


def report_text(rec: dict) -> str:
    """The Telegram note: what, where, the id to look it up by; never the diagnostics."""
    where = " · ".join((f"Page: {rec['page'] or '-'}", f"Lang: {rec['lang'] or '-'}",
                        f"Release: {rec['release'] or '-'}", f"Stage: {rec['stage'] or '-'}"))
    d = rec["diagnostics"]
    diag = (f"attached ({max(1, round(rec['diagBytes'] / 1024))} KB)" if d is True
            else "not stored, disk full" if d == "skipped" else "none")
    msg = rec["message"]
    short = msg if len(msg) <= TELEGRAM_MESSAGE_MAX else msg[: TELEGRAM_MESSAGE_MAX - 3] + "..."
    contact = "" if rec["kind"] == "error" else f"Contact: {rec['contact'] or '-'}\n"
    return (f"[{rec['kind'].upper()}][site={SITE}] {rec['id']}\n{where}\nDiagnostics: {diag}\n"
            f"{contact}Message:\n{short}")


# ---------------- leads (cooperation form) ----------------

LEAD_ROLES = ("scanner", "studio", "developer", "platform", "investor", "other")
LEAD_MESSAGE_MAX = 1000
EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,24}$")


def parse_lead(b: dict) -> dict:
    role = b.get("role") if b.get("role") in LEAD_ROLES else "other"
    email = _plain(b.get("email"), 254)
    if not EMAIL_RE.match(email) or b.get("consent") is not True:
        raise BadBody(400)
    try:
        t_ms = float(b.get("t") or 0)
    except (TypeError, ValueError):
        t_ms = 0
    return {"role": role, "email": email, "name": _plain(b.get("name"), 100),
            "message": _plain(b.get("message"), LEAD_MESSAGE_MAX, lines=True),
            "lang": _match(LANG_RE, b.get("lang") or b.get("locale")), "page": _match(SLUG_RE, b.get("page")),
            "suspect": bool(b.get("website")) or t_ms < 3000}


def store_lead(r: dict, now: float | None = None) -> dict:
    now = time.time() if now is None else now
    rec = {"id": f"L-{utc_day(now, '%Y%m%d')}-{uuid.uuid4().hex[:8]}", "ts": utc_ts(now), "site": SITE, **r}
    with S.lock:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        _append_durable(leads_file(), rec)
    return rec


def lead_text(rec: dict) -> str:
    return (f"[LEAD][site={SITE}][type={rec['role']}] {rec['id']}\nEmail: {rec['email']}\n"
            f"Name: {rec['name'] or '-'}\nLang: {rec['lang'] or '-'}\nMessage:\n{rec['message'] or '-'}")


# ---------------- events: daily totals only ----------------

SIZE_BUCKETS = {"lt100m", "100m-1g", "1g-4g", "4g-16g", "16g-64g", "gt64g"}
PROP_RULES: dict[str, set | re.Pattern] = {
    "lang": re.compile(r"[a-z]{2}"),
    "size": SIZE_BUCKETS,
    "stage": re.compile(r"[a-z0-9][a-z0-9_-]{0,23}"),
    "method": re.compile(r"[a-z0-9][a-z0-9_-]{0,23}"),
    "reason": re.compile(r"[a-z0-9][a-z0-9_-]{0,23}"),
    "preset": {"all", "standard", "aerial", "street", "interior", "object", "light", "custom"},
}
# event name -> its one optional property (None: a bare count)
EVENTS: dict[str, str | None] = {
    "page_view": "lang",
    "file_selected": "size",
    "convert_start": "size",
    "convert_done": "size",
    "convert_error": "stage",
    "convert_cancel": "stage",
    "save_fallback": "method",
    "feedback_open": None,
    "lead_submit": None,
    "lang_switch": "lang",
    "gpu_unavailable": "reason",
    "preset": "preset",
}
MAX_PROP_VALUES = 32   # distinct values of one property per event and day; the rest count as "other"


def clean_event(b: dict) -> tuple[str, str | None] | None:
    """(name, value) of an allowed event, or None for an unknown name. A value that is not allowed is
    dropped (the event still counts). The page sends {"e": name, "p": value} or {"e": name, "p": {prop: value}}."""
    name = b.get("e")
    if not isinstance(name, str) or name not in EVENTS:
        return None
    prop = EVENTS[name]
    p = b.get("p")
    if isinstance(p, dict) and prop is not None:
        p = p.get(prop)
    if prop is None or not isinstance(p, str):
        return name, None
    rule = PROP_RULES[prop]
    ok = p in rule if isinstance(rule, set) else bool(rule.fullmatch(p))
    return name, (p if ok else None)


class EventCounts:
    """Daily totals in memory, written to events-YYYY-MM-DD.json by flush() (every minute, on
    /api/stats, at shutdown). A day already on disk is read back first, so a restart loses at most
    the last unflushed minute. Holds today and any unflushed day only (caller holds S.lock)."""

    def __init__(self):
        self.days: dict[str, dict] = {}
        self.dirty: set[str] = set()

    def _day(self, day: str) -> dict:
        d = self.days.get(day)
        if d is None:
            d = {"counts": {}, "props": {}}
            try:
                old = json.loads(events_file(day).read_text(encoding="utf-8"))
                if isinstance(old.get("counts"), dict) and isinstance(old.get("props"), dict):
                    d = {"counts": old["counts"], "props": old["props"]}
            except (OSError, ValueError, AttributeError):
                pass
            self.days[day] = d
        return d

    def add(self, name: str, value: str | None, now: float) -> None:
        day = utc_day(now)
        d = self._day(day)
        d["counts"][name] = int(d["counts"].get(name, 0)) + 1
        if value is not None:
            pv = d["props"].setdefault(name, {})
            if value not in pv and len(pv) >= MAX_PROP_VALUES:
                value = "other"
            pv[value] = int(pv.get(value, 0)) + 1
        self.dirty.add(day)

    def flush(self, now: float) -> None:
        if S.guard["tripped"]:
            return  # kept in memory until there is room again
        if self.dirty:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
        for day in sorted(self.dirty):
            d = self.days[day]
            blob = {"day": day, "site": SITE, "counts": d["counts"], "props": d["props"]}
            _write_durable(events_file(day), json.dumps(blob, ensure_ascii=False, sort_keys=True).encode())
        self.dirty.clear()
        today = utc_day(now)
        for day in [d for d in self.days if d != today]:
            del self.days[day]


def flush_events() -> None:
    with S.lock:
        S.events.flush(time.time())


def stats(days: int, now: float | None = None) -> dict:
    """The daily totals of the last `days` UTC days (today included), oldest first."""
    now = time.time() if now is None else now
    out = {}
    with S.lock:
        S.events.flush(now)
        for i in range(days - 1, -1, -1):
            day = utc_day(now - i * 86400)
            if day in S.events.dirty or day in S.events.days:
                d = S.events.days[day]
                out[day] = {"counts": dict(d["counts"]), "props": json.loads(json.dumps(d["props"]))}
                continue
            try:
                d = json.loads(events_file(day).read_text(encoding="utf-8"))
                out[day] = {"counts": d.get("counts", {}), "props": d.get("props", {})}
            except (OSError, ValueError, AttributeError):
                continue
    return {"ok": True, "site": SITE, "days": out}


# ---------------- retention ----------------

def prune(now: float | None = None) -> None:
    """Diagnostics files older than REPORT_RETENTION_DAYS (by the date in their id) and daily totals
    older than EVENTS_RETENTION_DAYS. reports.jsonl and leads.jsonl are small and kept; see README."""
    now = time.time() if now is None else now
    diag_cut = utc_day(now - REPORT_RETENTION_DAYS * 86400, "%Y%m%d")
    ev_cut = utc_day(now - EVENTS_RETENTION_DAYS * 86400)
    with S.lock:
        if reports_dir().exists():
            for f in reports_dir().glob("R-*.json"):
                if REPORT_ID_RE.fullmatch(f.stem) and f.stem[2:10] < diag_cut:
                    f.unlink(missing_ok=True)
            S.dir_bytes.pop(str(reports_dir()), None)  # counted again from the disk
        for f in DATA_DIR.glob("events-*.json"):
            if f.name[7:17] < ev_cut:
                f.unlink(missing_ok=True)


def housekeeping() -> None:
    last_prune = 0.0
    while True:
        try:
            now = time.time()
            check_disk()
            flush_events()
            text = error_digest(now)
            if text:
                send_telegram(text)
            if now - last_prune > 3600:
                prune(now)
                last_prune = now
        except Exception:  # noqa: BLE001
            pass
        time.sleep(60)


# ---------------- HTTP ----------------

class Handler(BaseHTTPRequestHandler):
    server_version = "sog-api"
    sys_version = ""
    timeout = 20  # a client that stops sending is dropped: no thread waits on it for ever

    def log_request(self, code="-", size="-"):  # time, method, path, status: no address, no query
        print(f"{time.strftime('%H:%M:%S')} {self.command} {self.path.split('?')[0][:200]} {getattr(code, 'value', code)}", flush=True)

    def log_message(self, fmt, *args):  # the base class' error lines carry the client address: not printed
        cmd = getattr(self, "command", None) or "-"
        path = (getattr(self, "path", "") or "").split("?")[0][:200]
        print(f"{time.strftime('%H:%M:%S')} {cmd} {path} error", flush=True)

    def _json(self, code: int, obj: dict) -> None:
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _client(self) -> str:
        return client_key(self.headers, self.client_address[0])

    def _length(self) -> int:
        try:
            return int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise BadBody(400) from None

    def _drain(self, limit: int = MAX_UPLOAD) -> None:
        """Read a refused body away (up to `limit`), so the client gets the answer, not a reset."""
        try:
            left = self._length()
        except BadBody:
            return
        if left > limit:
            return
        while left > 0:
            got = len(self.rfile.read(min(left, 65536)))
            if not got:
                break
            left -= got

    def _body(self) -> dict:
        """A small JSON object (a lead, an event): at most MAX_BODY bytes."""
        n = self._length()
        if n <= 0:
            raise BadBody(400)
        if n > MAX_BODY:
            self._drain(4 * MAX_BODY)
            raise BadBody(413)
        try:
            v = json.loads(self.rfile.read(n))
        except ValueError as e:  # UnicodeDecodeError too
            raise BadBody(400) from e
        if not isinstance(v, dict):
            raise BadBody(400)
        return v

    def _upload(self) -> dict:
        """A body that may be large (a report with diagnostics): JSON, plain or gzip."""
        n = self._length()
        if n <= 0:
            raise BadBody(400)
        if n > MAX_UPLOAD:
            # read a modest excess away so the client gets the 413 instead of a reset; a huge one is
            # cut off (behind nginx client_max_body_size answers first)
            self._drain(4 * MAX_UPLOAD)
            raise BadBody(413)
        raw = self.rfile.read(n)
        enc = (self.headers.get("Content-Encoding") or "identity").strip().lower()
        if enc == "gzip":
            raw = gunzip_bounded(raw, MAX_INFLATED)
        elif enc != "identity":
            raise BadBody(415)
        try:
            v = json.loads(raw)
        except ValueError as e:
            raise BadBody(400) from e
        if not isinstance(v, dict):
            raise BadBody(400)
        return v

    def do_GET(self):
        path, _, qs = self.path.partition("?")
        if path == "/api/health":
            if S.guard["tripped"]:
                return self._json(503, {"ok": False, "reason": "disk"})
            return self._json(200, {"ok": True, "site": SITE})
        if path == "/api/stats":
            # nginx: allow 127.0.0.1, deny all. Checked again here: only a request that came from
            # the loopback (or straight to this container, without our nginx's headers) gets in.
            real, fwd = self.headers.get("X-Real-IP"), self.headers.get("X-Forwarded-For")
            if (real is not None and not _is_loopback(real)) or (fwd is not None and not all(_is_loopback(x) for x in fwd.split(","))):
                return self._json(403, {"ok": False})
            try:
                days = int(urllib.parse.parse_qs(qs).get("days", ["30"])[0])
            except ValueError:
                days = 30
            try:
                return self._json(200, stats(max(1, min(days, EVENTS_RETENTION_DAYS))))
            except OSError:
                return self._json(500, {"ok": False})
        self._json(404, {"ok": False})

    def do_POST(self):
        path = self.path.split("?")[0]
        client = self._client()
        try:
            if path == "/api/report":
                return self._report(client)
            if path == "/api/lead":
                return self._lead(client)
            if path == "/api/e":
                return self._event(client)
        except BadBody as e:
            return self._json(e.status, {"ok": False})
        except OSError:  # not stored: nothing is sent either
            return self._json(500, {"ok": False})
        self._drain(MAX_BODY)
        self._json(404, {"ok": False})

    def _report(self, client: str) -> None:
        if not S.allow("report_any", client):
            self._drain()
            return self._json(429, {"ok": False})
        r = parse_report(self._upload())
        if not S.allow("error" if r["kind"] == "error" else "report", client):
            return self._json(429, {"ok": False})
        rec = store_report(r)
        notify = not rec["suspect"] and not rec.get("repeatOf")
        mid = send_telegram(report_text(rec)) if notify else None
        self._json(200, {"ok": True, "id": rec["id"], "diagnostics": rec["diagnostics"], "delivered": mid is not None})

    def _lead(self, client: str) -> None:
        if not S.allow("lead", client):
            self._drain(MAX_BODY)
            return self._json(429, {"ok": False})
        rec = store_lead(parse_lead(self._body()))
        mid = None if rec["suspect"] else send_telegram(lead_text(rec))
        self._json(200, {"ok": True, "id": rec["id"], "delivered": mid is not None})

    def _event(self, client: str) -> None:
        if not S.allow("event", client):
            self._drain(MAX_BODY)
            return self._json(429, {"ok": False})
        ev = clean_event(self._body())
        if ev is None:
            raise BadBody(400)
        with S.lock:
            S.events.add(ev[0], ev[1], time.time())
        self.send_response(204)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):  # the default prints the client address
        e = sys.exc_info()[1]
        print(f"{time.strftime('%H:%M:%S')} request failed: {type(e).__name__}", flush=True)
        if os.environ.get("API_DEBUG"):
            traceback.print_exc()


S = State()


def main() -> None:
    check_disk()
    threading.Thread(target=housekeeping, daemon=True).start()

    def stop(*_):  # docker stop: write the day's totals, then leave
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, stop)
    port = int(os.environ.get("PORT", "8090"))
    httpd = Server(("0.0.0.0", port), Handler)
    print(f"{time.strftime('%H:%M:%S')} sog-api listening on :{port}", flush=True)
    try:
        httpd.serve_forever()
    except (SystemExit, KeyboardInterrupt):
        pass
    finally:
        flush_events()


if __name__ == "__main__":
    main()
