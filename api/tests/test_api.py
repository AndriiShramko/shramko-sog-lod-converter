"""Tests of api/server.py: reports (bug, idea, error), leads, events, stats, rate limits, privacy.

Run from the repository root:   python -m unittest discover -s api/tests -v
Stdlib only, no network: a real HTTP server on a free port and a temporary DATA_DIR; Telegram is a
recording function (except where the real one is checked with no token: delivered false). One case
starts `python api/server.py` as its own process, the way the container does. Most checks carry a
negative control: the same request with the one thing changed, which must come out the other way.
"""
from __future__ import annotations

import gzip
import http.client
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import tracemalloc
import unittest
from pathlib import Path

API = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(API))
import server  # noqa: E402

DIAG = {"release": "1a2b3c4", "stage": "lod", "stack": "TypeError: x at sort (worker.js:1:2)",
        "errors": ["TypeError: x"], "gpu": {"vendor": "nvidia", "architecture": "ada"},
        "input": {"sizeBytes": 123456789, "splats": 2000000, "name": "my-house.ply", "path": "C:/Users/me/my-house.ply"},
        "secretThing": "not on the whitelist"}


class Api(unittest.TestCase):
    """A real HTTP server on a temporary data directory; Telegram recorded, never called."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.saved = {k: getattr(server, k) for k in ("DATA_DIR", "send_telegram", "REPORTS_CAP_BYTES")}
        self.saved_log = server.Handler.log_request
        server.Handler.log_request = lambda *a, **k: None  # quiet test output (the subprocess case checks the log)
        server.DATA_DIR = self.dir
        server.reset_state()
        self.sent: list[tuple[str, bool]] = []

        def fake_telegram(text: str):
            # stored before sent: the record must already be on disk when the message goes
            rid = text.splitlines()[0].split()[-1]
            files = [server.reports_file(), server.leads_file()]
            stored = any(f.exists() and rid in f.read_text(encoding="utf-8") for f in files)
            self.sent.append((text, stored))
            return len(self.sent)

        server.send_telegram = fake_telegram
        self.api = server.Server(("127.0.0.1", 0), server.Handler)
        threading.Thread(target=self.api.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()

    def tearDown(self):
        self.api.shutdown()
        self.api.server_close()
        for k, v in self.saved.items():
            setattr(server, k, v)
        server.Handler.log_request = self.saved_log
        server.reset_state()
        self.tmp.cleanup()

    def call(self, method: str, path: str, body=None, ip: str | None = "203.0.113.5", headers: dict | None = None):
        """A request as our nginx forwards it: X-Real-IP and X-Forwarded-For both = the visitor."""
        c = http.client.HTTPConnection("127.0.0.1", self.api.server_address[1], timeout=10)
        raw = body if isinstance(body, bytes) or body is None else json.dumps(body).encode()
        h = {"Content-Type": "application/json"}
        if ip is not None:
            h.update({"X-Real-IP": ip, "X-Forwarded-For": ip})
        h.update(headers or {})
        c.request(method, path, body=raw, headers=h)
        r = c.getresponse()
        out = r.read()
        c.close()
        return r.status, out

    def report(self, ip: str = "203.0.113.5", **over) -> tuple[int, dict]:
        b = {"kind": "bug", "message": "The LOD zip has no lod-meta.json at the root", "contact": "@scanner",
             "lang": "en", "page": "convert", "release": "1a2b3c4", "stage": "lod", "t": 9000, "website": "",
             "diagnosticsConsent": True, "diagnostics": DIAG}
        b.update(over)
        s, raw = self.call("POST", "/api/report", {k: v for k, v in b.items() if v is not None}, ip=ip)
        return s, json.loads(raw) if raw else {}

    def error(self, ip: str = "198.51.100.20", **over) -> tuple[int, dict]:
        b = {"kind": "error", "message": "RangeError: Array buffer allocation failed at 123456789 splats",
             "lang": "en", "page": "convert", "release": "1a2b3c4", "stage": "sort",
             "diagnosticsConsent": True, "diagnostics": DIAG}
        b.update(over)
        return self.report(ip=ip, **b)

    def records(self) -> list[dict]:
        f = server.reports_file()
        return [json.loads(x) for x in f.read_text(encoding="utf-8").splitlines()] if f.exists() else []

    def diag_files(self) -> list[Path]:
        d = server.reports_dir()
        return sorted(d.iterdir()) if d.exists() else []


class Health(Api):
    def test_health_and_disk_guard(self):
        s, raw = self.call("GET", "/api/health")
        self.assertEqual((s, json.loads(raw)), (200, {"ok": True, "site": "sog"}))
        server.S.guard["tripped"] = True
        s, raw = self.call("GET", "/api/health")
        self.assertEqual((s, json.loads(raw)["ok"]), (503, False))
        server.S.guard["tripped"] = False
        self.assertEqual(self.call("GET", "/api/health")[0], 200)  # control
        self.assertEqual(self.call("GET", "/api/nope")[0], 404)
        self.assertEqual(self.call("POST", "/api/nope", {"x": 1})[0], 404)


class Reports(Api):
    def test_stored_before_telegram_and_the_note(self):
        s, b = self.report(message="x" * 1500)
        self.assertEqual((s, b["ok"], b["diagnostics"], b["delivered"]), (200, True, True, True))
        self.assertRegex(b["id"], r"^R-[0-9]{8}-0001$")
        self.assertEqual(len(self.sent), 1)
        text, stored = self.sent[0]
        self.assertTrue(stored, "the record was not on disk when Telegram was called")
        self.assertTrue(text.startswith(f"[BUG][site=sog] {b['id']}\n"))
        self.assertIn("Page: convert · Lang: en · Release: 1a2b3c4 · Stage: lod", text)
        self.assertIn("Diagnostics: attached", text)
        self.assertIn("Contact: @scanner", text)
        self.assertIn("x" * 597 + "...", text)
        self.assertNotIn("x" * 601, text)            # only the first 600 characters
        self.assertNotIn("TypeError", text)          # never the diagnostics
        # control: storage that fails sends nothing (the order is store, then send)
        server.DATA_DIR = self.dir / "a-file"
        server.DATA_DIR.write_text("not a directory")
        s2, _ = self.report()
        self.assertEqual(s2, 500)
        self.assertEqual(len(self.sent), 1)

    def test_ids_count_per_day_and_survive_a_restart(self):
        ids = [self.report()[1]["id"] for _ in range(3)]
        self.assertEqual([i[-4:] for i in ids], ["0001", "0002", "0003"])
        server.S.seq.update(day="", n=0, file=None)  # a restart forgets the counter
        self.assertTrue(self.report()[1]["id"].endswith("-0004"))

    def test_bug_without_consent_stores_no_diagnostics(self):
        s, b = self.report(diagnosticsConsent=False)
        self.assertEqual((s, b["diagnostics"]), (200, False))
        self.assertIs(self.records()[-1]["diagnostics"], False)
        self.assertEqual(self.diag_files(), [])
        self.assertNotIn("TypeError", server.reports_file().read_text(encoding="utf-8"))
        # "true" as a string is not consent
        self.assertEqual(self.report(diagnosticsConsent="true")[1]["diagnostics"], False)
        self.assertEqual(self.diag_files(), [])
        # control: with consent the same report keeps them, in their own file, not in reports.jsonl
        s, b = self.report()
        self.assertEqual((s, b["diagnostics"]), (200, True))
        f = server.reports_dir() / f"{b['id']}.json"
        self.assertEqual(self.diag_files(), [f])
        self.assertEqual(json.loads(f.read_text(encoding="utf-8"))["diagnostics"]["errors"], ["TypeError: x"])
        self.assertNotIn("TypeError", server.reports_file().read_text(encoding="utf-8"))

    def test_diagnostics_whitelist_and_scrub(self):
        b = self.report()[1]
        d = json.loads((server.reports_dir() / f"{b['id']}.json").read_text(encoding="utf-8"))["diagnostics"]
        self.assertEqual(d["input"]["sizeBytes"], 123456789)   # control: the useful parts stay
        self.assertEqual(d["gpu"]["vendor"], "nvidia")
        self.assertNotIn("secretThing", d)                     # not on the whitelist
        self.assertNotIn("name", d["input"])                   # names a visitor's file
        self.assertNotIn("path", d["input"])
        raw = (server.reports_dir() / f"{b['id']}.json").read_text(encoding="utf-8")
        self.assertNotIn("my-house", raw)

    def test_idea_never_keeps_diagnostics(self):
        s, b = self.report(kind="idea", message="Export a 3-level LOD preset")
        self.assertEqual((s, b["diagnostics"]), (200, False))
        self.assertEqual(self.diag_files(), [])
        self.assertTrue(self.sent[-1][0].startswith(f"[IDEA][site=sog] {b['id']}"))

    def test_error_kind(self):
        # sent by the converter itself: no typing, no time-to-submit, diagnostics with consent
        s, b = self.error()
        self.assertEqual((s, b["diagnostics"], b["delivered"]), (200, True, True))
        rec = self.records()[-1]
        self.assertEqual((rec["kind"], rec["suspect"], rec["stage"], rec["contact"]), ("error", False, "sort", ""))
        text = self.sent[-1][0]
        self.assertTrue(text.startswith(f"[ERROR][site=sog] {b['id']}\n"))
        self.assertIn("Stage: sort", text)
        self.assertNotIn("Contact:", text)
        self.assertNotIn("TypeError", text)
        # negative control: the box unticked, the same error keeps no diagnostics
        s, b = self.error(diagnosticsConsent=False, message="Another failure")
        self.assertEqual((s, b["diagnostics"]), (200, False))
        self.assertEqual(len(self.diag_files()), 1)

    def test_error_dedup(self):
        s, first = self.error()
        self.assertEqual((s, first["delivered"], len(self.sent)), (200, True, 1))
        # the same error from another visitor, other numbers in the message: stored, not announced
        s, again = self.error(ip="198.51.100.21", message="RangeError: Array buffer allocation failed at 98 splats")
        self.assertEqual((s, again["delivered"], len(self.sent)), (200, False, 1))
        self.assertEqual(self.records()[-1]["repeatOf"], first["id"])
        self.assertTrue((server.reports_dir() / f"{again['id']}.json").exists())  # still stored in full
        # controls: another stage, another release, another message are announced
        self.assertTrue(self.error(stage="zip")[1]["delivered"])
        self.assertTrue(self.error(release="9f9f9f9")[1]["delivered"])
        self.assertTrue(self.error(message="WebGPU device lost")[1]["delivered"])
        self.assertEqual(len(self.sent), 4)
        # a restart forgets nothing: the dedup state is on disk
        server.reset_state()
        s, third = self.error(ip="198.51.100.22")
        self.assertEqual((s, third["delivered"], len(self.sent)), (200, False, 4))
        # the daily count line: once a day, the repeats since the last one
        tomorrow = time.time() + 86400
        text = server.error_digest(tomorrow)
        self.assertIsNotNone(text)
        self.assertTrue(text.startswith("[ERROR][site=sog] repeats up to "))
        self.assertIn(f"{first['id']} x2 release=1a2b3c4 stage=sort", text)
        self.assertIsNone(server.error_digest(tomorrow + 60))   # control: not twice a day
        self.assertIsNone(server.error_digest(tomorrow + 86400))  # nothing repeated since: no line
        # 24 h after the first one the same error is announced again
        r = server.parse_report({"kind": "error", "message": "RangeError: Array buffer allocation failed at 1 splats",
                                 "release": "1a2b3c4", "stage": "sort"})
        self.assertEqual(server.store_report(r, now=time.time() + 25 * 3600)["repeatOf"], "")
        # a suspect error is never counted: the same text sent clean afterwards is still a first
        self.error(message="Suspect only", website="x")
        self.assertEqual(len(self.sent), 4)
        self.assertTrue(self.error(message="Suspect only")[1]["delivered"])

    def test_honeypot_makes_a_suspect(self):
        for kind in ("bug", "idea", "error"):
            s, b = self.report(kind=kind, website="http://spam.example", t=9000)
            self.assertEqual((s, b["ok"], b["delivered"], b["diagnostics"]), (200, True, False, False))
        self.assertEqual(len(self.sent), 0)
        self.assertEqual([r["suspect"] for r in self.records()], [True, True, True])
        self.assertEqual(self.diag_files(), [])  # a suspect keeps no diagnostics
        self.assertTrue(self.report()[1]["delivered"])  # control: a person's report goes on

    def test_time_to_submit(self):
        self.assertFalse(self.report(t=800)[1]["delivered"])
        self.assertFalse(self.report(kind="idea", t=None)[1]["delivered"])
        self.assertEqual([r["suspect"] for r in self.records()], [True, True])
        self.assertEqual(len(self.sent), 0)
        # errors are exempt from the time check
        self.assertTrue(self.error(t=0)[1]["delivered"])
        # control: the same bug after 3 s goes on
        self.assertTrue(self.report(t=3000)[1]["delivered"])

    def test_whitelist_and_bad_input(self):
        self.assertEqual(self.report(kind="spam")[0], 400)
        self.assertEqual(self.report(message="   ")[0], 400)
        self.assertEqual(self.call("POST", "/api/report", b"[1, 2]")[0], 400)
        self.assertEqual(self.call("POST", "/api/report", b"{not json")[0], 400)
        self.assertEqual(self.call("POST", "/api/report", b"")[0], 400)
        s, _ = self.report(page="../../etc", release="<b>", lang="xxx", stage="Sort Stage", contact="a\u202eb\x00c")
        self.assertEqual(s, 200)
        rec = self.records()[-1]
        self.assertEqual((rec["page"], rec["release"], rec["lang"], rec["stage"], rec["contact"]), ("", "", "", "", "abc"))
        self.report(lang=None, locale="pl")  # the page may call it locale
        self.assertEqual(self.records()[-1]["lang"], "pl")
        self.report()  # control: the clean values are kept
        self.assertEqual((self.records()[-1]["page"], self.records()[-1]["stage"]), ("convert", "lod"))

    def test_size_limits(self):
        self.assertEqual(self.report(extra="x" * 9000)[0], 413)                        # words over 8 KB
        self.assertEqual(self.report(diagnostics={"log": ["x" * 3000] * 210})[0], 413)  # > 512 KB on the wire
        self.assertEqual(self.report(diagnostics={"log": ["x" * 3000] * 130})[0], 200)  # control: ~400 KB

    def test_gzip(self):
        def gz(log_bytes: int) -> bytes:
            return gzip.compress(json.dumps({"kind": "bug", "message": "m", "t": 9000, "diagnosticsConsent": True,
                                             "diagnostics": {"log": "0" * log_bytes}}).encode())
        bomb = gz(3 * 1024 * 1024)
        self.assertLess(len(bomb), server.MAX_UPLOAD)  # small on the wire, 3 MB unpacked
        self.assertEqual(self.call("POST", "/api/report", bomb, headers={"Content-Encoding": "gzip"})[0], 413)
        self.assertEqual(self.call("POST", "/api/report", b"\x1f\x8bnot gzip", headers={"Content-Encoding": "gzip"})[0], 400)
        self.assertEqual(self.call("POST", "/api/report", gz(1000)[:-12], headers={"Content-Encoding": "gzip"})[0], 400)  # cut short
        self.assertEqual(self.call("POST", "/api/report", b"{}", headers={"Content-Encoding": "br"})[0], 415)
        self.assertEqual(self.records(), [])
        # control: 1.5 MB of diagnostics gzipped passes
        s, raw = self.call("POST", "/api/report", gz(1536 * 1024), headers={"Content-Encoding": "gzip"})
        self.assertEqual((s, json.loads(raw)["diagnostics"]), (200, True))

    def test_reports_cap_and_disk_guard(self):
        server.REPORTS_CAP_BYTES = 10
        s, b = self.report()
        self.assertEqual((s, b["diagnostics"]), (200, "skipped"))
        self.assertIn("Diagnostics: not stored, disk full", self.sent[-1][0])
        server.REPORTS_CAP_BYTES = self.saved["REPORTS_CAP_BYTES"]
        server.S.guard["tripped"] = True
        self.assertEqual(self.report()[1]["diagnostics"], "skipped")
        server.S.guard["tripped"] = False
        self.assertEqual(self.report()[1]["diagnostics"], True)  # control
        self.assertEqual(len(self.diag_files()), 1)


class RateLimits(Api):
    def test_eleventh_report_an_hour_is_refused(self):
        for i in range(10):
            self.assertEqual(self.report(kind=("bug", "idea")[i % 2])[0], 200)
        self.assertEqual(self.report()[0], 429)
        self.assertEqual(self.report(kind="idea")[0], 429)
        # controls: another visitor is not limited by the first one; errors have their own budget
        self.assertEqual(self.report(ip="198.51.100.7")[0], 200)
        self.assertEqual(self.error(ip="203.0.113.5")[0], 200)

    def test_errors_twenty_an_hour(self):
        for i in range(20):
            self.assertEqual(self.error(ip="198.51.100.30", message=f"failure kind {chr(97 + i)}")[0], 200)
        self.assertEqual(self.error(ip="198.51.100.30", message="one more")[0], 429)
        self.assertEqual(self.report(ip="198.51.100.30")[0], 200)  # control: the bug budget is apart

    def test_pre_gate_before_the_body(self):
        # 40 requests an hour reach the body parser at all, valid or not
        for _ in range(40):
            self.assertEqual(self.call("POST", "/api/report", b"{not json", ip="198.51.100.40")[0], 400)
        self.assertEqual(self.report(ip="198.51.100.40")[0], 429)
        self.assertEqual(self.report(ip="198.51.100.41")[0], 200)  # control

    def test_forged_x_forwarded_for_does_not_bypass(self):
        forged = [f"10.9.{i}.{i}, 192.0.2.{i + 1}" for i in range(11)]
        # 1) behind a proxy that appends (nginx-proxy style): the visitor's own entries come first,
        #    the address the proxy saw is the last one, and that is the one the API takes
        hdrs = [f"{f}, 203.0.113.9" for f in forged]
        codes = [self.call("POST", "/api/report", self.body(), ip=None, headers={"X-Forwarded-For": h})[0] for h in hdrs]
        self.assertEqual(codes, [200] * 10 + [429])
        # negative control: keyed by the FIRST entry (the gsfpv API) these were 11 different visitors
        self.assertEqual(len({h.split(",")[0].strip() for h in hdrs}), 11)
        # 2) our nginx sets X-Real-IP (after real_ip): whatever X-Forwarded-For says does not matter
        codes = [self.call("POST", "/api/report", self.body(), ip=None,
                           headers={"X-Real-IP": "203.0.113.10", "X-Forwarded-For": h})[0] for h in forged]
        self.assertEqual(codes, [200] * 10 + [429])
        # control: a different real address is a different visitor
        self.assertEqual(self.call("POST", "/api/report", self.body(), ip="203.0.113.11")[0], 200)

    def body(self) -> dict:
        return {"kind": "idea", "message": "More LOD levels", "t": 9000}

    def test_client_key(self):
        ck = server.client_key
        self.assertEqual(ck({"X-Forwarded-For": "1.2.3.4, 203.0.113.9"}, "172.18.0.5"), "203.0.113.9")
        self.assertEqual(ck({"X-Real-IP": "203.0.113.7", "X-Forwarded-For": "1.2.3.4"}, "172.18.0.5"), "203.0.113.7")
        self.assertEqual(ck({"X-Real-IP": "garbage"}, "172.18.0.5"), "172.18.0.5")
        self.assertEqual(ck({}, "::ffff:203.0.113.8"), "203.0.113.8")
        # IPv6: one /64 is one visitor (a host can rotate addresses inside its prefix)
        self.assertEqual(ck({"X-Real-IP": "2001:db8:1:2::1"}, "x"), ck({"X-Real-IP": "2001:db8:1:2:ffff::9"}, "x"))
        self.assertNotEqual(ck({"X-Real-IP": "2001:db8:1:2::1"}, "x"), ck({"X-Real-IP": "2001:db8:1:3::1"}, "x"))  # control

    def test_limiter_map_is_bounded(self):
        rl = server.RateLimiter(3, 3600, max_keys=100)
        for i in range(10000):
            rl.hit(f"10.0.{i // 256}.{i % 256}", now=1000.0)
        self.assertEqual(len(rl), 100)
        # control: a key still counts up to its limit
        self.assertEqual([rl.hit("k", now=1000.0) for _ in range(4)], [True, True, True, False])
        # idle keys are swept after two windows
        rl2 = server.RateLimiter(5, 60)
        for i in range(500):
            rl2.hit(f"k{i}", now=0.0)
        self.assertEqual(len(rl2), 500)
        rl2.hit("late", now=121.0)
        self.assertEqual(len(rl2), 1)
        # every limiter of the server is capped
        self.assertTrue(all(r.max_keys == server.MAX_KEYS for r in server.S.limits.values()))

    def test_limiter_memory(self):
        tracemalloc.start()
        before = tracemalloc.get_traced_memory()[0]
        rl = server.RateLimiter(600, 3600)
        for i in range(server.MAX_KEYS + 5000):
            rl.hit(f"203.0.{i // 256 % 256}.{i % 256}-{i}", now=1.0)
        used = tracemalloc.get_traced_memory()[0] - before
        tracemalloc.stop()
        self.assertEqual(len(rl), server.MAX_KEYS)
        self.assertLess(used, 5 * 1024 * 1024, f"{used} bytes for {server.MAX_KEYS} keys")

    def test_sliding_window(self):
        rl = server.RateLimiter(10, 3600)
        self.assertEqual(sum(rl.hit("a", now=0.0) for _ in range(11)), 10)
        # halfway through the next hour half of the last hour's hits still count
        self.assertEqual(sum(rl.hit("a", now=5400.0) for _ in range(10)), 5)
        # two hours of quiet: a full budget again
        self.assertEqual(sum(rl.hit("a", now=4 * 3600.0) for _ in range(11)), 10)


class Leads(Api):
    def lead(self, **over) -> tuple[int, dict]:
        b = {"role": "scanner", "email": "ops@scan.example", "name": "Ola", "message": "We scan castles, 2 bn splats",
             "consent": True, "lang": "en", "page": "cooperate", "t": 9000, "website": ""}
        b.update(over)
        s, raw = self.call("POST", "/api/lead", {k: v for k, v in b.items() if v is not None})
        return s, json.loads(raw) if raw else {}

    def test_validation(self):
        self.assertEqual(self.lead(email="not-an-email")[0], 400)
        self.assertEqual(self.lead(email=None)[0], 400)
        self.assertEqual(self.lead(consent=None)[0], 400)
        self.assertEqual(self.lead(consent="true")[0], 400)
        self.assertEqual(self.lead(extra="x" * 9000)[0], 413)
        self.assertFalse(server.leads_file().exists())
        self.assertEqual(self.sent, [])
        # control: a complete one is stored, then announced
        s, b = self.lead(message="m" * 1500)
        self.assertEqual((s, b["ok"], b["delivered"]), (200, True, True))
        rec = json.loads(server.leads_file().read_text(encoding="utf-8").splitlines()[-1])
        self.assertEqual((rec["role"], rec["email"], len(rec["message"])), ("scanner", "ops@scan.example", 1000))
        text, stored = self.sent[-1]
        self.assertTrue(stored)
        self.assertTrue(text.startswith(f"[LEAD][site=sog][type=scanner] {b['id']}"))
        self.assertEqual(self.lead(role="hacker")[0], 200)
        self.assertIn("[type=other]", self.sent[-1][0])

    def test_spam_and_rate(self):
        self.assertFalse(self.lead(website="x")[1]["delivered"])
        self.assertFalse(self.lead(t=500)[1]["delivered"])
        self.assertEqual(self.sent, [])
        for _ in range(6):
            self.assertEqual(self.lead()[0], 200)
        self.assertEqual(self.lead()[0], 429)  # the 9th within the hour
        self.assertEqual(len(self.sent), 6)


class Events(Api):
    def ev(self, body, ip="203.0.113.5") -> int:
        return self.call("POST", "/api/e", body, ip=ip)[0]

    def test_allow_list_and_daily_totals(self):
        self.assertEqual(self.ev({"e": "track_me"}), 400)
        self.assertEqual(self.ev({"e": ["page_view"]}), 400)
        self.assertEqual(self.ev(b"[1]"), 400)
        for _ in range(3):
            self.assertEqual(self.ev({"e": "page_view", "p": "en"}), 204)
        self.assertEqual(self.ev({"e": "convert_done", "p": "1g-4g"}), 204)
        self.assertEqual(self.ev({"e": "convert_done", "p": {"size": "1g-4g"}}), 204)
        self.assertEqual(self.ev({"e": "convert_done", "p": "huge"}), 204)       # a value off the list: counted bare
        self.assertEqual(self.ev({"e": "feedback_open", "p": "anything"}), 204)  # no property: counted bare
        server.flush_events()
        day = server.utc_day(time.time())
        f = server.events_file(day)
        d = json.loads(f.read_text(encoding="utf-8"))
        self.assertEqual(d["counts"], {"page_view": 3, "convert_done": 3, "feedback_open": 1})
        self.assertEqual(d["props"], {"page_view": {"en": 3}, "convert_done": {"1g-4g": 2}})
        raw = f.read_text(encoding="utf-8")
        self.assertNotIn("203.0.113", raw)  # no address, no per-event lines
        self.assertEqual(sorted(p.name for p in self.dir.iterdir()), [f.name])
        # a restart adds to the day already on disk
        server.reset_state()
        self.assertEqual(self.ev({"e": "page_view", "p": "pl"}), 204)
        server.flush_events()
        d = json.loads(f.read_text(encoding="utf-8"))
        self.assertEqual((d["counts"]["page_view"], d["props"]["page_view"]), (4, {"en": 3, "pl": 1}))

    def test_property_values_are_bounded(self):
        now = time.time()
        with server.S.lock:
            for i in range(40):
                server.S.events.add("page_view", "a" + chr(97 + i % 26) if i < 26 else "b" + chr(97 + i - 26), now)
        pv = server.S.events.days[server.utc_day(now)]["props"]["page_view"]
        self.assertEqual(len(pv), server.MAX_PROP_VALUES + 1)
        self.assertEqual(pv["other"], 40 - server.MAX_PROP_VALUES)

    def test_stats_only_from_the_loopback(self):
        self.ev({"e": "convert_start", "p": "4g-16g"})
        self.assertEqual(self.call("GET", "/api/stats", ip="203.0.113.5")[0], 403)
        self.assertEqual(self.call("GET", "/api/stats", ip=None, headers={"X-Forwarded-For": "127.0.0.1, 203.0.113.5"})[0], 403)
        s, raw = self.call("GET", "/api/stats?days=7", ip="127.0.0.1")
        self.assertEqual(s, 200)
        days = json.loads(raw)["days"]
        self.assertEqual(days[server.utc_day(time.time())]["counts"], {"convert_start": 1})
        self.assertEqual(self.call("GET", "/api/stats", ip=None)[0], 200)  # straight to the container

    def test_queue_events(self):
        for b in ({"e": "queue_add", "p": "3"}, {"e": "queue_start", "p": "12"}, {"e": "queue_done", "p": "4"}, {"e": "queue_done", "p": "x9"}):
            self.assertEqual(self.ev(b), 204)
        day = server.S.events.days[server.utc_day(time.time())]
        self.assertEqual(day["counts"], {"queue_add": 1, "queue_start": 1, "queue_done": 2})
        self.assertEqual(day["props"], {"queue_add": {"3": 1}, "queue_start": {"12": 1}, "queue_done": {"4": 1}})  # "x9" not a count: dropped

    def test_event_rate_limit(self):
        server.S.limits["event"] = server.RateLimiter(5, 3600)
        self.assertEqual([self.ev({"e": "page_view"}) for _ in range(6)], [204] * 5 + [429])
        self.assertEqual(self.ev({"e": "page_view"}, ip="198.51.100.3"), 204)  # control
        self.assertEqual(server.LIMITS["event"], (600, 3600))


class Telegram(Api):
    def test_no_token_means_not_delivered(self):
        server.send_telegram = self.saved["send_telegram"]
        env = {k: os.environ.pop(k) for k in ("TG_BOT_TOKEN", "TG_CHAT_ID") if k in os.environ}
        try:
            self.assertIsNone(server.send_telegram("x"))
            s, b = self.report()
            self.assertEqual((s, b["ok"], b["delivered"]), (200, True, False))
            self.assertEqual(self.records()[-1]["id"], b["id"])  # stored all the same
        finally:
            os.environ.update(env)


class Process(unittest.TestCase):
    """`python api/server.py` as the container runs it: env config, real Telegram path with no token, logs."""

    def test_the_real_process(self):
        with tempfile.TemporaryDirectory() as tmp:
            s = socket.socket()
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
            s.close()
            env = {k: v for k, v in os.environ.items() if not k.startswith("TG_")}
            env.update(DATA_DIR=tmp, PORT=str(port), MIN_FREE_GB="0", PYTHONUNBUFFERED="1")
            p = subprocess.Popen([sys.executable, str(API / "server.py")], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            try:
                for _ in range(100):
                    try:
                        c = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
                        c.request("GET", "/api/health")
                        if c.getresponse().status == 200:
                            break
                    except OSError:
                        time.sleep(0.1)
                else:
                    self.fail("the server did not start")
                c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                c.request("POST", "/api/report?secret=query", body=json.dumps({"kind": "idea", "message": "hi", "t": 9000}),
                          headers={"X-Real-IP": "198.51.100.77", "X-Forwarded-For": "198.51.100.77"})
                r = c.getresponse()
                b = json.loads(r.read())
                self.assertEqual((r.status, b["ok"], b["delivered"]), (200, True, False))
                self.assertTrue((Path(tmp) / "reports.jsonl").exists())
            finally:
                p.terminate()
                out = p.communicate(timeout=10)[0].decode("utf-8", "replace")
            self.assertIn("POST /api/report 200", out)
            self.assertIn("GET /api/health 200", out)
            self.assertNotIn("198.51.100.77", out)  # no client address in the log
            self.assertNotIn("127.0.0.1", out)
            self.assertNotIn("secret", out)         # no query string either
            self.assertNotIn("198.51.100.77", (Path(tmp) / "reports.jsonl").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
