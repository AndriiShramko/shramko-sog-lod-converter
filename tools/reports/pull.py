"""Reports (bugs, ideas, automatic error reports) and usage totals from sog.flyreelstudio.eu, for the
owner and the agent who fixes things. There is no public URL that lists reports: this script reads
them from the hub over SSH into tools/reports/inbox/ (gitignored: reports hold visitors' words and
contacts, never commit them).

  python tools/reports/pull.py pull                     # reports.jsonl + every diagnostics file
  python tools/reports/pull.py list [--kind bug|idea|error] [--all] [--repeats] [--suspect]
                                                        # open reports, newest first; --all: closed too;
                                                        # repeats of an error are folded into its first
  python tools/reports/pull.py show R-20261002-0007     # the record, its diagnostics in short
  python tools/reports/pull.py close R-20261002-0007 --note "fixed in 1a2b3c4"
  python tools/reports/pull.py reopen R-20261002-0007
  python tools/reports/pull.py stats [--days 30] [--local]
                                                        # daily event totals (pulls them first)
  python tools/reports/pull.py --selftest               # list/show/close/stats on a fixture, no SSH

The hub is named in deploy/hub.env (gitignored; deploy/hub.env.example has the keys):
  SOG_HOST  user@host (or the host alone, plus SOG_USER)
  SOG_PORT  SSH port (default 22)       SOG_KEY   private key (default ~/.ssh/id_ed25519)
  SOG_BASE  the service directory on the hub; the API's data is $SOG_BASE/data
This script reads that file itself and ignores the shell environment on purpose: in Git Bash,
`set -a; . deploy/hub.env` silently rewrites a value that looks like a POSIX path (SOG_BASE=/home/x
becomes C:/Program Files/Git/home/x) before Python ever sees it.

Open or closed is kept in inbox/status.json on this machine (one line per change, the newest wins).
"""
from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import re
import shlex
import subprocess
import sys
import tarfile
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
HUB_ENV = REPO / "deploy" / "hub.env"
ID_RE = re.compile(r"R-[0-9]{8}-[0-9]{4,}")
KINDS = ("bug", "idea", "error")
EVENT_ORDER = ("page_view", "file_selected", "convert_start", "convert_done", "convert_error", "convert_cancel",
               "gpu_unavailable", "save_fallback", "feedback_open", "lead_submit", "lang_switch")
EVENT_SHORT = ("view", "file", "start", "done", "error", "cancel", "nogpu", "savefb", "fdbk", "lead", "lang")

# what a pulled tar may contain: exact names only (no links, no "..", no absolute paths), size caps
TAR_RULES = (
    (re.compile(r"reports\.jsonl"), 256 * 1024 * 1024),
    (re.compile(r"reports/(R-[0-9]{8}-[0-9]{4,})\.json"), 3 * 1024 * 1024),
    (re.compile(r"events-[0-9]{4}-[0-9]{2}-[0-9]{2}\.json"), 4 * 1024 * 1024),
)


class Inbox:
    """Where pulled data lives (tools/reports/inbox/, or a fixture for --selftest)."""

    def __init__(self, root: Path):
        self.root = root
        self.reports = root / "reports.jsonl"
        self.diag = root / "reports"
        self.status = root / "status.json"
        self.events = root / "events"


INBOX = Inbox(HERE / "inbox")


# ---------------- the hub ----------------

def hub() -> dict:
    """deploy/hub.env as a dict, checked: a mangled or odd value stops here, before any SSH."""
    if not HUB_ENV.exists():
        sys.exit(f"{HUB_ENV} is missing: copy deploy/hub.env.example and fill it in")
    env = {}
    for line in HUB_ENV.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    for k in ("SOG_HOST", "SOG_BASE"):
        if not env.get(k):
            sys.exit(f"{HUB_ENV}: {k} is not set")
    user, _, host = env["SOG_HOST"].rpartition("@")   # deploy/hub.env.example writes user@host
    user = env.get("SOG_USER") or user
    if not user:
        sys.exit(f"{HUB_ENV}: SOG_HOST must be user@host (or set SOG_USER)")
    base = env["SOG_BASE"].rstrip("/")
    if re.match(r"^[A-Za-z]:", base) or "Program Files" in base:
        sys.exit(f"SOG_BASE={base!r} looks rewritten by Git Bash: it must be the hub's POSIX path (/home/...)")
    if not re.fullmatch(r"/[A-Za-z0-9._/-]+", base) or ".." in base.split("/"):
        sys.exit(f"SOG_BASE={base!r}: expected an absolute POSIX path")
    if not re.fullmatch(r"[A-Za-z0-9.:-]+", host) or not re.fullmatch(r"[a-z_][a-z0-9_-]*", user):
        sys.exit(f"{HUB_ENV}: SOG_HOST / SOG_USER have unexpected characters")
    port = env.get("SOG_PORT") or "22"
    if not port.isdigit():
        sys.exit(f"{HUB_ENV}: SOG_PORT must be a number")
    key = os.path.expanduser(env.get("SOG_KEY") or "~/.ssh/id_ed25519")
    if re.match(r"^/[a-zA-Z]/", key):  # /c/Users/... (Git Bash style) -> C:/Users/...
        key = f"{key[1].upper()}:/{key[3:]}"
    return {"ssh": ["ssh", "-p", port, "-i", key, "-o", "ConnectTimeout=20", "-o", "BatchMode=yes",
                    f"{user}@{host}"], "data": f"{base}/data"}


def ssh_tar(remote: str, timeout: int = 600) -> bytes:
    h = hub()
    r = subprocess.run(h["ssh"] + [f"cd {shlex.quote(h['data'])} 2>/dev/null || exit 0; {remote}"],
                       capture_output=True, timeout=timeout)
    if r.returncode != 0:
        sys.exit(f"ssh failed ({r.returncode}): {r.stderr.decode(errors='replace').strip()}")
    return r.stdout


def safe_extract(blob: bytes, dest: Path) -> dict[str, int]:
    """Writes only the members TAR_RULES allow, under `dest`, by names this script builds itself.
    Never tarfile.extractall: a link, a device, an absolute path or a ".." is skipped, not followed."""
    counts = {"files": 0, "skipped": 0}
    if not blob:
        return counts
    try:
        tar = tarfile.open(fileobj=io.BytesIO(blob), mode="r:")
        members = tar.getmembers()
    except tarfile.TarError as e:
        sys.exit(f"the hub sent a broken tar ({e}); nothing was written")
    with tar:
        for m in members:
            name = m.name[2:] if m.name.startswith("./") else m.name
            if m.isdir() and name.rstrip("/") == "reports":
                continue
            rule = next((cap for rx, cap in TAR_RULES if rx.fullmatch(name)), None)
            if rule is None or not m.isreg() or m.size > rule:
                counts["skipped"] += 1
                continue
            parts = name.split("/")
            out = dest.joinpath(*parts)
            out.parent.mkdir(parents=True, exist_ok=True)
            tmp = out.with_name(out.name + ".tmp")
            tmp.write_bytes(tar.extractfile(m).read())
            os.replace(tmp, out)
            counts["files"] += 1
    return counts


def pull() -> None:
    blob = ssh_tar('f=; [ -f reports.jsonl ] && f="$f reports.jsonl"; [ -d reports ] && f="$f reports"; '
                   '[ -z "$f" ] || tar cf - $f')
    INBOX.root.mkdir(parents=True, exist_ok=True)
    c = safe_extract(blob, INBOX.root)
    print(f"{len(records())} reports, {c['files']} files, {c['skipped']} skipped -> {INBOX.root}")


def pull_events() -> None:
    blob = ssh_tar('set -- events-*.json; [ -e "$1" ] || exit 0; tar cf - "$@"')
    INBOX.events.mkdir(parents=True, exist_ok=True)
    c = safe_extract(blob, INBOX.events)
    print(f"{c['files']} daily totals, {c['skipped']} skipped -> {INBOX.events}")


# ---------------- the inbox ----------------

def records() -> list[dict]:
    if not INBOX.reports.exists():
        return []
    out = []
    for line in INBOX.reports.read_text(encoding="utf-8").splitlines():
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if isinstance(r, dict) and ID_RE.fullmatch(str(r.get("id", ""))):
            out.append(r)
    return out


def statuses() -> dict[str, dict]:
    st: dict[str, dict] = {}
    if INBOX.status.exists():
        for line in INBOX.status.read_text(encoding="utf-8").splitlines():
            try:
                s = json.loads(line)
                st[s["id"]] = s
            except (ValueError, KeyError, TypeError):
                continue
    return st


def state_of(r: dict, st: dict[str, dict]) -> str:
    """A repeat of an error follows its first report unless it was closed or reopened itself."""
    own = st.get(r["id"])
    if own:
        return own["status"]
    first = r.get("repeatOf")
    return st.get(first, {}).get("status", "open") if first else "open"


def set_status(rid: str, status: str, note: str) -> None:
    if not any(r.get("id") == rid for r in records()):
        sys.exit(f"{rid}: not in {INBOX.reports} (run `pull` first)")
    INBOX.root.mkdir(parents=True, exist_ok=True)
    with INBOX.status.open("a", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps({"id": rid, "status": status, "note": note, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())},
                           ensure_ascii=False) + "\n")
    print(f"{rid}: {status}")


def list_reports(kind: str | None, show_all: bool, repeats: bool, suspect: bool) -> None:
    st = statuses()
    rows = [r for r in records() if (kind is None or r.get("kind") == kind) and (suspect or not r.get("suspect"))]
    folded: dict[str, int] = {}
    if not repeats:
        for r in rows:
            if r.get("repeatOf"):
                folded[r["repeatOf"]] = folded.get(r["repeatOf"], 0) + 1
        rows = [r for r in rows if not r.get("repeatOf")]
    rows = [r for r in rows if show_all or state_of(r, st) == "open"]
    for r in sorted(rows, key=lambda r: r["id"], reverse=True):
        first = (r.get("message") or "").splitlines()[0][:80] if r.get("message") else ""
        diag = "diag" if r.get("diagnostics") is True else "    "
        more = f"+{folded[r['id']]}" if r["id"] in folded else ""
        flag = "SUSPECT " if r.get("suspect") else ""
        print(f"{r['id']}  {r.get('kind', '?'):5} {state_of(r, st):6} {diag} {more:>4} {r.get('page') or '-':8} "
              f"{r.get('lang') or '-':2} {r.get('release') or '-':8} {r.get('stage') or '-':8}  {flag}{first}")
    print(f"{len(rows)} {'' if show_all else 'open '}reports" + (f" ({kind})" if kind else "")
          + (f", {sum(folded.values())} repeats folded" if folded else ""))


def show(rid: str) -> None:
    recs = records()
    rec = next((r for r in recs if r.get("id") == rid), None)
    if rec is None:
        sys.exit(f"{rid}: not in {INBOX.reports} (run `pull` first)")
    print(json.dumps(rec, ensure_ascii=False, indent=1))
    st = statuses().get(rid)
    if st:
        print(f"status: {st['status']} ({st['at']}) {st.get('note', '')}")
    reps = [r["id"] for r in recs if r.get("repeatOf") == rid]
    if reps:
        print(f"repeats ({len(reps)}): {', '.join(reps[:20])}{' ...' if len(reps) > 20 else ''}")
    f = INBOX.diag / f"{rid}.json"
    if not f.exists():
        print("diagnostics: none" if rec.get("diagnostics") is not True else f"diagnostics: {f} missing (run `pull`)")
        return
    d = json.loads(f.read_text(encoding="utf-8")).get("diagnostics", {})
    print(f"diagnostics: {f}")
    for k, v in d.items():
        if k in ("errors", "log") and isinstance(v, list):
            print(f"  {k} ({len(v)}{', last 30' if len(v) > 30 else ''}):")
            for e in v[-30:]:
                print(f"    {e if isinstance(e, str) else json.dumps(e, ensure_ascii=False)}"[:300])
        elif k == "stack" and isinstance(v, str):
            print("  stack:")
            for line in v.splitlines()[:20]:
                print(f"    {line[:200]}")
        else:
            print(f"  {k}: {json.dumps(v, ensure_ascii=False)[:300]}")


# ---------------- usage totals ----------------

def stats(days: int) -> None:
    files = sorted(INBOX.events.glob("events-*.json"))[-days:] if INBOX.events.exists() else []
    if not files:
        print(f"no daily totals in {INBOX.events} (run `stats` without --local)")
        return
    print("day         " + " ".join(f"{s:>6}" for s in EVENT_SHORT))
    total: dict[str, int] = {}
    props: dict[str, dict[str, int]] = {}
    for f in files:
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except ValueError:
            continue
        c = d.get("counts", {})
        for k, v in c.items():
            total[k] = total.get(k, 0) + int(v)
        for name, pv in d.get("props", {}).items():
            for val, n in pv.items():
                props.setdefault(name, {})[val] = props.setdefault(name, {}).get(val, 0) + int(n)
        print(f"{d.get('day', f.stem[7:]):11} " + " ".join(f"{int(c.get(e, 0)):>6}" for e in EVENT_ORDER))
    print(f"{'total':11} " + " ".join(f"{total.get(e, 0):>6}" for e in EVENT_ORDER))
    starts = total.get("convert_start", 0)
    if starts:
        print(f"done/start {100 * total.get('convert_done', 0) / starts:.1f}%  "
              f"error/start {100 * total.get('convert_error', 0) / starts:.1f}%  "
              f"cancel/start {100 * total.get('convert_cancel', 0) / starts:.1f}%")
    for name in EVENT_ORDER:
        if props.get(name):
            top = sorted(props[name].items(), key=lambda kv: -kv[1])[:8]
            print(f"  {name}: " + ", ".join(f"{k} {v}" for k, v in top))


# ---------------- self-test (no SSH) ----------------

def _fixture(root: Path) -> None:
    rows = [
        {"id": "R-20261001-0001", "ts": "2026-10-01T09:00:00Z", "site": "sog", "kind": "bug", "page": "convert", "lang": "en",
         "release": "1a2b3c4", "stage": "lod", "message": "The zip has no lod-meta.json", "contact": "@a", "suspect": False,
         "diagnostics": True, "diagBytes": 900},
        {"id": "R-20261001-0002", "ts": "2026-10-01T10:00:00Z", "site": "sog", "kind": "idea", "page": "convert", "lang": "pl",
         "release": "1a2b3c4", "stage": "", "message": "A preset for 3 LOD levels", "contact": "", "suspect": False,
         "diagnostics": False, "diagBytes": 0},
        {"id": "R-20261002-0001", "ts": "2026-10-02T08:00:00Z", "site": "sog", "kind": "error", "page": "convert", "lang": "en",
         "release": "1a2b3c4", "stage": "sort", "message": "RangeError: Array buffer allocation failed at 12 splats",
         "contact": "", "suspect": False, "diagnostics": True, "diagBytes": 700, "repeatOf": ""},
        {"id": "R-20261002-0002", "ts": "2026-10-02T08:05:00Z", "site": "sog", "kind": "error", "page": "convert", "lang": "en",
         "release": "1a2b3c4", "stage": "sort", "message": "RangeError: Array buffer allocation failed at 99 splats",
         "contact": "", "suspect": False, "diagnostics": False, "diagBytes": 0, "repeatOf": "R-20261002-0001"},
        {"id": "R-20261002-0003", "ts": "2026-10-02T09:00:00Z", "site": "sog", "kind": "bug", "page": "convert", "lang": "en",
         "release": "", "stage": "", "message": "buy cheap pills", "contact": "", "suspect": True, "diagnostics": False, "diagBytes": 0},
    ]
    root.mkdir(parents=True)
    (root / "reports.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows) + "not json\n", encoding="utf-8")
    (root / "reports").mkdir()
    (root / "reports" / "R-20261002-0001.json").write_text(json.dumps({"id": "R-20261002-0001", "diagnostics": {
        "release": "1a2b3c4", "stack": "RangeError: Array buffer allocation failed\n    at sortMorton (worker.js:1:200)",
        "gpu": {"vendor": "nvidia", "architecture": "ada"}, "input": {"sizeBytes": 6_000_000_000, "splats": 25_000_000},
        "log": [f"stage sort {i}%" for i in range(0, 100, 2)]}}), encoding="utf-8")
    (root / "events").mkdir()
    for day, k in (("2026-10-01", 1), ("2026-10-02", 2)):
        (root / "events" / f"events-{day}.json").write_text(json.dumps({"day": day, "site": "sog", "counts": {
            "page_view": 100 * k, "file_selected": 40 * k, "convert_start": 30 * k, "convert_done": 25 * k, "convert_error": 3 * k,
            "convert_cancel": 2 * k, "gpu_unavailable": 4}, "props": {"convert_done": {"1g-4g": 20 * k, "gt64g": 5 * k},
                                                                     "page_view": {"en": 80 * k, "pl": 20 * k}}}), encoding="utf-8")


def _tar(members: list[tuple[str, bytes | None, str]]) -> bytes:
    """A tar in memory: (name, data, kind) with kind "file", "symlink" or "dir"."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as t:
        for name, data, kind in members:
            ti = tarfile.TarInfo(name)
            if kind == "symlink":
                ti.type, ti.linkname = tarfile.SYMTYPE, "/etc/passwd"
                t.addfile(ti)
            elif kind == "dir":
                ti.type = tarfile.DIRTYPE
                t.addfile(ti)
            else:
                ti.size = len(data)
                t.addfile(ti, io.BytesIO(data))
    return buf.getvalue()


def selftest() -> None:
    global INBOX, HUB_ENV
    saved = INBOX
    checks = 0

    def run(title: str, fn, *a) -> str:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            fn(*a)
        print(f"$ {title}\n{out.getvalue()}", end="")
        return out.getvalue()

    def check(cond: bool, what: str) -> None:
        nonlocal checks
        if not cond:
            sys.exit(f"selftest FAILED: {what}")
        checks += 1

    with tempfile.TemporaryDirectory() as tmp:
        INBOX = Inbox(Path(tmp) / "inbox")
        try:
            _fixture(INBOX.root)
            out = run("list", list_reports, None, False, False, False)
            check("R-20261001-0001" in out and "R-20261001-0002" in out and "R-20261002-0001" in out, "list shows the open reports")
            check("R-20261002-0002" not in out, "a repeat is folded into its first report")
            check("+1" in out and "1 repeats folded" in out, "the folded repeat is counted")
            check("R-20261002-0003" not in out, "a suspect report is hidden")
            out = run("list --kind error --repeats", list_reports, "error", False, True, False)
            check("R-20261002-0002" in out and "R-20261001-0001" not in out, "--kind and --repeats")
            out = run("show R-20261002-0001", show, "R-20261002-0001")
            check("sortMorton" in out and "6000000000" in out and "repeats (1): R-20261002-0002" in out, "show prints the diagnostics")
            check("log (50, last 30)" in out, "show trims a long log")
            out = run('close R-20261002-0001 --note "fixed in abc1234"', set_status, "R-20261002-0001", "closed", "fixed in abc1234")
            out = run("list", list_reports, None, False, False, False)
            check("R-20261002-0001" not in out and "2 open reports" in out, "a closed report leaves the open list")
            out = run("list --repeats", list_reports, None, False, True, False)
            check("R-20261002-0002" not in out, "a repeat follows its first report's state")
            out = run("list --all", list_reports, None, True, False, False)
            check("closed" in out and "3 reports" in out, "--all shows closed ones")
            out = run("show R-20261002-0001", show, "R-20261002-0001")
            check("status: closed" in out and "fixed in abc1234" in out, "show prints the status")
            run("reopen R-20261002-0001", set_status, "R-20261002-0001", "open", "")
            out = run("list", list_reports, None, False, False, False)
            check("3 open reports" in out, "reopen puts it back")
            out = run("stats --local", stats, 30)
            check("total" in out and "done/start 83.3%" in out and "convert_done: 1g-4g 60, gt64g 15" in out, "stats sums the days")
            # the tar filter: only exact names, regular files, under the inbox
            evil = _tar([("reports", None, "dir"), ("reports/R-20261003-0001.json", b"{}", "file"), ("../escape.json", b"x", "file"),
                         ("/etc/cron.d/x", b"x", "file"), ("reports/R-20261003-0002.json", None, "symlink"),
                         ("reports/notes.txt", b"x", "file"), ("reports/../../up.json", b"x", "file"), ("./reports.jsonl", b"", "file")])
            dest = Path(tmp) / "extract"
            c = safe_extract(evil, dest)
            got = sorted(str(p.relative_to(dest)).replace("\\", "/") for p in dest.rglob("*") if p.is_file())
            print(f"$ tar filter\n{c} -> {got}")
            check(got == ["reports.jsonl", "reports/R-20261003-0001.json"] and c["skipped"] == 5, "the tar filter keeps only allowed files")
            check(not (Path(tmp) / "escape.json").exists() and not (Path(tmp) / "up.json").exists(), "nothing escapes the inbox")
            # deploy/hub.env: read from the file, a Git-Bash-mangled path refused (no SSH is run)
            HUB_ENV = Path(tmp) / "hub.env"
            want = {"ssh": ["ssh", "-p", "22022", "-i", "C:/Users/me/.ssh/k", "-o", "ConnectTimeout=20", "-o", "BatchMode=yes",
                            "deploy@hub.example"], "data": "/home/deploy/sog/data"}
            for hosts in ("SOG_HOST=deploy@hub.example", "SOG_HOST=hub.example\nSOG_USER=deploy"):
                HUB_ENV.write_text(f"# test\n{hosts}\nSOG_PORT=22022\nSOG_KEY=/c/Users/me/.ssh/k\nSOG_BASE='/home/deploy/sog/'\n",
                                   encoding="utf-8")
                h = hub()
                print(f"$ hub.env {hosts!r} -> {h}")
                check(h == want, "hub.env gives the ssh command")
            for bad in ("C:/Program Files/Git/home/deploy/sog", "/home/x/../../etc", "/home/x;rm -rf /"):
                HUB_ENV.write_text(f"SOG_HOST=deploy@hub.example\nSOG_BASE={bad}\n", encoding="utf-8")
                try:
                    hub()
                    check(False, f"SOG_BASE={bad} accepted")
                except SystemExit as e:
                    print(f"$ SOG_BASE={bad} -> refused: {e}")
                    check("SOG_BASE" in str(e), f"SOG_BASE={bad} refused for the wrong reason")
        finally:
            INBOX = saved
            HUB_ENV = REPO / "deploy" / "hub.env"
    print(f"selftest: OK ({checks} checks, no SSH)")


def main() -> None:
    if "--selftest" in sys.argv[1:]:
        return selftest()
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("pull")
    pl = sub.add_parser("list")
    pl.add_argument("--kind", choices=KINDS)
    pl.add_argument("--all", action="store_true")
    pl.add_argument("--repeats", action="store_true", help="list each repeat of an error on its own line")
    pl.add_argument("--suspect", action="store_true", help="include honeypot / too-fast reports")
    ps = sub.add_parser("show")
    ps.add_argument("id")
    for name in ("close", "reopen"):
        pc = sub.add_parser(name)
        pc.add_argument("id")
        pc.add_argument("--note", default="")
    pst = sub.add_parser("stats")
    pst.add_argument("--days", type=int, default=30)
    pst.add_argument("--local", action="store_true", help="only what is already in inbox/events/")
    a = p.parse_args()
    if a.cmd == "pull":
        pull()
    elif a.cmd == "list":
        list_reports(a.kind, a.all, a.repeats, a.suspect)
    elif a.cmd == "show":
        show(a.id)
    elif a.cmd == "stats":
        if not a.local:
            pull_events()
        stats(max(1, a.days))
    else:
        set_status(a.id, "closed" if a.cmd == "close" else "open", a.note)


if __name__ == "__main__":
    main()
