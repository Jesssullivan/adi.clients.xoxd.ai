"""overlay/server.py against a fixture deck, the pinned core's deploy/ templates, a fake Kubernetes API, a local
valkey-server standing in for a run's queue pod, and a fake Grafana."""

import contextlib
import http.client
import json
import math
import os
import re
import socket
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler
import urllib.error
import urllib.parse
from datetime import UTC, datetime
from pathlib import Path
from unittest import mock

import jwt as pyjwt
import redis
import server
import yaml
from cryptography.hazmat.primitives.asymmetric import rsa
from adi_sms.fate import DEFAULTS, Summary, deliver, run_range, __file__ as FATE

D = {f: getattr(DEFAULTS, f) for f in server.PARAMS}  # the spec defaults
IMAGE = "ghcr.io/jesssullivan/adi-sms@sha256:" + "ab" * 32
COMMIT = Path(FATE).with_name("commit.lua").read_text()  # the core's one commit: ack, count and delete

# Throwaway RSA pairs that sign test JWTs the way Cloudflare Access signs its own (RS256); the team publishes KEY's.
KEY, OTHER = (rsa.generate_private_key(65537, 2048) for _ in range(2))
JWKS = {"keys": [pyjwt.algorithms.RSAAlgorithm.to_jwk(KEY.public_key(), as_dict=True) | {"kid": "k1"}]}
TEAM = "https://team.cloudflareaccess.com"


def jwt(aud, exp=2e9, kid="k1", iss=TEAM, key=KEY, alg="RS256", **claims):
    return pyjwt.encode({"aud": [aud], "exp": exp, "iss": iss} | claims, key, alg, {"kid": kid})


def parse(text: str) -> dict:  # a rendered Job as the API would return it
    job = yaml.safe_load(text)
    job["metadata"]["creationTimestamp"] = "2026-10-10T18:00:00Z"
    job["spec"].setdefault("parallelism", 1)
    return job


class Fake:  # the API paths the server calls, answered from dicts
    def __init__(self):
        self.jobs, self.pods, self.posted, self.patched = {}, {}, [], []

    def __call__(self, method, path, body="", ctype=""):
        if method == "POST":
            self.posted.append(body)
            return self.jobs.setdefault((job := parse(body))["metadata"]["name"], job)
        if method == "PATCH":  # a merge patch of the annotations lands on the Job, as the API merges it
            self.patched.append((name := path.rsplit("/", 1)[1], ctype, patch := json.loads(body)))
            if name in self.jobs and "metadata" in patch:
                self.jobs[name]["metadata"].setdefault("annotations", {}).update(patch["metadata"]["annotations"])
            return {}
        if "/pods?" in path:
            return {"items": self.pods.get(urllib.parse.unquote(path).rsplit("=", 1)[1], [])}
        if "/pods/" in path:
            return {"spec": {"containers": [{"image": IMAGE}]}}
        if path.endswith("/jobs"):
            return {"items": list(self.jobs.values())}
        return self.jobs[path.rsplit("/", 1)[1]]


def pod(name, phase="Running", ip=None, t="2026-10-10T18:00:01Z"):
    return {"metadata": {"name": name, "creationTimestamp": t}, "status": {"phase": phase} | ({"podIP": ip} if ip else {})}


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Server(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        d = Path(cls.tmp.name)
        for f, body in {"index.html": "home", "deck.html": "deck", "404.html": "missing", "resume.html": "resume", "demo.html": "demo",
                        "resume/a.pdf": "%PDF", "d/index.html": "dir", "_app/immutable/a.js": "js", "x.json": "{}"}.items():
            (d / "deck" / f).parent.mkdir(parents=True, exist_ok=True)
            (d / "deck" / f).write_text(body)
        (d / "deck/_app/immutable/a.js.br").write_bytes(b"BR")
        (d / "notes.json").write_text('{"deck": "x", "notes": {}}')
        cls.patches = [mock.patch.object(server, "DECK", (d / "deck").resolve()), mock.patch.object(server, "NOTES", d / "notes.json"),
                       mock.patch.object(server.Handler, "log_message", lambda *a: None),
                       mock.patch.object(server, "AUD", ["off"]),  # the Access check has its own test
                       mock.patch.dict(os.environ, {"POD_NAME": "web-0", "PULL_SECRET": "ghcr-pull",
                                                    "ADI_NOW": str(datetime(2026, 10, 10, 8, tzinfo=UTC).timestamp())})]
        for p in cls.patches:
            p.start()
        cls.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        for p in cls.patches:
            p.stop()
        cls.tmp.cleanup()

    def setUp(self):  # each test's queue: a valkey-server as the queue pod runs it, here on a free port
        self.k8s, self.port = Fake(), free_port()
        valkey = subprocess.Popen(["valkey-server", "--save", "", "--port", str(self.port), "--bind", "127.0.0.1"],
                                  stdout=subprocess.DEVNULL)
        self.addCleanup(valkey.wait), self.addCleanup(valkey.terminate)
        self.valkey, self.db = valkey, redis.Redis("127.0.0.1", self.port, decode_responses=True)
        for _ in range(100):
            with contextlib.suppress(redis.ConnectionError):
                self.db.ping()
                break
            time.sleep(0.05)
        server.RUNS.clear()
        self.enterContext(mock.patch.object(server, "QPORT", self.port))
        patch = mock.patch.object(server, "kube", self.k8s)
        patch.start()
        self.addCleanup(patch.stop)
        self.addCleanup(server.RUNS.clear)

    def req(self, method, path, body=None, headers=None):
        c = http.client.HTTPConnection(*self.httpd.server_address)
        c.request(method, path, body, headers or {})
        r = c.getresponse()
        out = r.status, dict(r.getheaders()), r.read()
        c.close()
        return out

    def post(self, path, body):
        status, _, out = self.req("POST", path, json.dumps(body), {"Content-Type": "application/json"})
        return status, json.loads(out)

    def live(self, run="sms-20261010-080000", cfg=DEFAULTS, p=1):  # a run whose pipeline has started its Jobs
        server.RUNS[run] = {"run": run, "created": "2026-10-10T08:00:00+00:00", "phase": "Running", "cfg": cfg,
                            "params": {f: getattr(cfg, f) for f in server.PARAMS}, "image": IMAGE, "P": p,
                            "floor": p, "rate": cfg.rate, "t": time.monotonic(), "made": 0, "consumers": [],
                            "final": None, "totals": dict.fromkeys((*Summary._fields, "done"), 0),
                            "db": redis.Redis("127.0.0.1", self.port, decode_responses=True)}
        return server.RUNS[run]

    def step(self, run, dt=1.0):  # one control step dt seconds after the last
        server.RUNS[run]["t"] = time.monotonic() - dt
        return server.tick(run)

    def test_close_down_at_17_00_edt_on_2026_10_26(self):  # the clock moves through ADI_NOW
        self.assertEqual(server.CLOSE_AT, datetime(2026, 10, 26, 21, tzinfo=UTC).timestamp())
        self.assertEqual(server.AFTER_CLOSE, "https://github.com/Jesssullivan")
        for t, code in ((server.CLOSE_AT - 1, 200), (server.CLOSE_AT, 302), (server.CLOSE_AT + 86400, 302)):
            with mock.patch.dict(os.environ, {"ADI_NOW": str(t)}):
                for method, path in (("GET", "/"), ("GET", "/presenter/notes.json"), ("GET", "/demo"),
                                     ("GET", "/demo/api/runs"), ("POST", "/demo/api/run"), ("HEAD", "/deck"),
                                     ("GET", "/metrics"), ("GET", "/grafana/"), ("POST", "/grafana/api/ds/query")):
                    status, h, _ = self.req(method, path, b"{}", {"Content-Type": "application/json"})
                    if code == 302:
                        self.assertEqual((status, h["Location"], h["Cache-Control"]), (302, server.AFTER_CLOSE, "no-store"))
                    else:
                        self.assertNotEqual(status, 302)

    def test_every_path_but_the_probe_and_metrics_needs_a_valid_access_jwt(self):
        with mock.patch.object(server, "AUD", ["guest", "owner"]), mock.patch.object(server, "TEAM", TEAM), \
                mock.patch.object(pyjwt.PyJWKClient, "fetch_data", return_value=JWKS):
            ok = lambda path, token: self.req("GET", path, headers={"Cf-Access-Jwt-Assertion": token})[0]
            self.assertEqual((ok("/", jwt("guest")), ok("/presenter/notes.json", jwt("owner"))), (200, 200))
            self.assertEqual((ok("/healthz", ""), ok("/metrics", "")), (200, 200))
            hs256 = pyjwt.encode({"aud": ["guest"], "exp": 2e9, "iss": TEAM}, "k" * 32, "HS256", {"kid": "k1"})
            for path, token in (("/", ""), ("/", "a.b.c"), ("/", jwt("owner")), ("/presenter/notes.json", jwt("guest")),
                                ("/", jwt("guest", exp=1)), ("/", jwt("guest", iss="https://other.example")),
                                ("/", jwt("guest", nbf=2e9)), ("/", jwt("guest", key=OTHER)), ("/", hs256),
                                ("/", jwt("guest", key=None, alg="none")), ("/demo/api/runs", jwt("guest")[:-4] + "AAAA")):
                self.assertEqual(ok(path, token), 403, (path, token[:20]))
            self.assertEqual(ok("/", jwt("guest", kid="k2")), 403)  # a kid Cloudflare lacks
            self.assertEqual(ok("/", jwt("guest", exp=time.time() - 30)), 200)  # inside the 60 s leeway
            self.assertEqual(server.access(jwt("guest", email="a@b.example"), "/demo/api/run"), "a@b.example")
            self.assertEqual(server.access(jwt("guest"), "/"), "")  # a valid token without an email
            self.assertRaises(pyjwt.ExpiredSignatureError, server.access, jwt("guest", exp=1, email="a@b.example"), "/")

    def test_who_started_and_halted_a_run_is_shown_in_full_to_an_owner_and_masked_to_anyone_else(self):
        old = parse(server.render("senders", "sms-20261009-120000", IMAGE=IMAGE, P=4, QUEUE="q", FLAGS=server.flags(DEFAULTS)))
        old["metadata"]["annotations"] = {"adi-sms/started-by": "jess@example.org", "adi-sms/halted-by": "guest@example.com"}
        self.k8s.jobs = {"sms-20261009-120000-senders": old | {"status": {"conditions": [{"type": "Complete", "status": "True"}]}}}
        with mock.patch.object(server, "AUD", ["guest", "owner"]), mock.patch.object(server, "TEAM", TEAM), \
                mock.patch.object(pyjwt.PyJWKClient, "fetch_data", return_value=JWKS), mock.patch.object(server, "OWNERS", {"jess@example.org"}):
            seen = lambda email: json.loads(self.req("GET", "/demo/api/runs", headers={
                "Cf-Access-Jwt-Assertion": jwt("guest", email=email)})[2])[0]  # read back from the Job after a restart
            self.assertEqual([seen(e)[k] for e in ("Jess@Example.org", "x@y.example") for k in ("started_by", "halted_by", "phase")],
                             ["jess@example.org", "guest@example.com", "Halted", "j***@example.org", "g***@example.com", "Halted"])
        self.assertEqual(server.mask({"run": "r", "started_by": None}, None), {"run": "r", "started_by": None})

    def test_pages_resolution(self):
        cases = {"/": (200, b"home"), "/deck": (200, b"deck"), "/resume": (200, b"resume"), "/resume/a.pdf": (200, b"%PDF"),
                 "/d/": (200, b"dir"), "/nope": (404, b"missing"), "/../../etc/passwd": (404, b"missing"),
                 "/%2e%2e/%2e%2e/etc/passwd": (404, b"missing"), "/deck.html": (308, "/deck"), "/index.html": (308, "/"),
                 "/deck/": (308, "/deck"), "/resume/": (308, "/resume"), "/d": (308, "/d/"), "/d/index.html": (308, "/d/"),
                 "/deck.html?embed=1": (308, "/deck?embed=1")}
        for path, (code, want) in cases.items():
            status, h, body = self.req("GET", path)
            self.assertEqual(status, code, path)
            self.assertEqual(h["Location"] if code == 308 else body, want, path)
        # an encoded leading slash names the deck by its absolute path: a 404, never a //host redirect
        status, h, _ = self.req("GET", "/" + urllib.parse.quote(f"{server.DECK}/deck.html", safe=""))
        self.assertEqual((status, h.get("Location")), (404, None))
        _, h, _ = self.req("GET", "/")
        self.assertEqual((h["Content-Type"], h["Cache-Control"]), ("text/html; charset=utf-8", "private, no-cache"))
        _, h, _ = self.req("GET", "/x.json")
        self.assertEqual(h["Content-Type"], "application/json; charset=utf-8")

    def test_precompressed_immutable_and_head(self):
        status, h, body = self.req("GET", "/_app/immutable/a.js", headers={"Accept-Encoding": "gzip, br"})
        self.assertEqual((status, body, h["Content-Encoding"]), (200, b"BR", "br"))
        self.assertEqual(h["Cache-Control"], "private, max-age=31536000, immutable")
        _, h, body = self.req("GET", "/_app/immutable/a.js")
        self.assertEqual((body, h.get("Content-Encoding")), (b"js", None))
        status, h, body = self.req("HEAD", "/deck")
        self.assertEqual((status, body, h["Content-Length"]), (200, b"", "4"))

    def test_notes_are_served_only_at_their_raw_path(self):
        status, h, body = self.req("GET", "/presenter/notes.json")
        self.assertEqual((status, json.loads(body)["deck"]), (200, "x"))
        self.assertEqual((h["Cache-Control"], h["X-Robots-Tag"]), ("private, no-store", "noindex"))
        for path in ("/presenter/notes%2Ejson", "/presenter%2Fnotes.json", "/presenter/notes.json/"):
            self.assertEqual(self.req("GET", path)[0], 404, path)
        with mock.patch.object(server, "NOTES", server.NOTES.with_name("absent.json")):  # no notes Secret: a 404
            self.assertEqual(self.req("GET", "/presenter/notes.json")[0], 404)


    def test_demo_page_and_spec(self):  # /demo is the deck build's demo.html, framed only by the deck
        status, h, body = self.req("GET", "/demo")
        csp = "frame-ancestors 'self'; frame-src 'self' https://www.youtube-nocookie.com; img-src 'self' data: https://i.ytimg.com"
        self.assertEqual((status, body, h["Content-Security-Policy"]), (200, b"demo", csp))
        spec = json.loads(self.req("GET", "/demo/api/spec")[2])
        self.assertEqual(set(spec["params"]), set(server.PARAMS))
        self.assertEqual({f: p["default"] for f, p in spec["params"].items()}, D)
        self.assertEqual([spec["caps"][k] for k in ("P_MAX", "M_MAX", "RATE_MAX", "MAKESPAN_S")], [10, 100, 2000, 600])

    def test_render_changes_only_the_placeholders(self):
        for part in ("queue", "producer", "senders"):
            out = server.render(part, "sms-x", IMAGE=IMAGE, P=3, QUEUE="10.0.0.9:6379", FLAGS=server.flags(DEFAULTS))
            template = [x for x in (server.DEPLOY / f"{part}.yaml").read_text().splitlines() if not re.match(r" *#", x)]
            self.assertNotIn("${", out)
            self.assertEqual(len(out.splitlines()), len(template))
            for a, b in zip(template, out.splitlines(), strict=True):
                self.assertEqual(a == b, "${" not in a, a)
            self.assertEqual(parse(out)["metadata"]["name"], f"sms-x-{part}")  # the template appends the part
            self.assertIn('name: "ghcr-pull"', out)
            self.assertEqual(parse(out)["spec"]["template"]["spec"]["containers"][0]["image"], IMAGE)
            with mock.patch.dict(os.environ, {"PULL_SECRET": ""}):  # no secret: the line goes, as in the core's render
                self.assertNotIn("imagePullSecrets", server.render(part, "sms-x", IMAGE=IMAGE, P=3, QUEUE="", FLAGS=""))
        senders = parse(server.render("senders", "sms-x", IMAGE=IMAGE, P=3, QUEUE="10.0.0.9:6379", FLAGS=server.flags(DEFAULTS)))
        self.assertEqual(senders["spec"]["parallelism"], 3)
        self.assertTrue(any("10.0.0.9:6379" in w for w in senders["spec"]["template"]["spec"]["containers"][0]["command"]))
        self.assertEqual(server.describe(senders | {"status": {}})["params"], D)

    def test_run_is_validated_then_starts_the_queue_then_the_producer_and_senders(self):
        self.assertEqual(self.req("POST", "/demo/api/run", b"{}", {"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.req("POST", "/elsewhere", b"{}", {"Content-Type": "application/json"})[0], 404)
        for bad in ({"n": -1}, {"senders": 0}, {"n": 1.5}, {"workers": 0}, {"workers": 11}, {"workers": "3"}, {"rate": -1},
                    {"rate": 2001}, {"rate": 2.5}, {"n": 2_000_000}, {"n": 1_000_000, "mean_us": 10_000_000},
                    {"n": 100_000, "rate": 100}, {"bogus": 1}, [1], {"senders": 101},
                    {"mean_us": 0, "attempts": 10, "backoff_us": 50_000, "fail_ppm": 1_000_000},  # N E[tau] / (P M) = 2555 s
                    {"mean_us": 1_000_000}):  # one message may take 37 s, past the 30 s lease

            self.assertEqual(self.post("/demo/api/run", bad)[0], 400, bad)
        for size in ("4097", "-1", "x"):  # the body is bounded and read before the run lock
            self.assertEqual(self.req("POST", "/demo/api/run", b"{}", {"Content-Type": "application/json",
                                                                      "Content-Length": size})[0], 400, size)
        self.assertEqual(self.k8s.posted, [])
        run, shutdown = "sms-20261010-080000", self.enterContext(mock.patch.object(redis.Redis, "shutdown"))
        self.k8s.pods[f"{run}-queue"] = [pod("q", ip="127.0.0.1")]
        status, body = self.post("/demo/api/run", {"n": 50, "workers": 2, "rate": 50, "interval_ms": 100})
        self.assertEqual((status, body["run"], body["P"], body["rate"], body["params"]["n"]), (201, run, 2, 50, 50))
        self.assertEqual(parse(self.k8s.posted[0])["metadata"]["name"], f"{run}-queue")
        for _ in range(100):  # the pipeline thread: the queue answers, then the producer and the senders start
            if server.RUNS[run]["phase"] != "Starting":
                break
            time.sleep(0.05)
        self.assertEqual(server.RUNS[run]["phase"], "Running")
        self.assertEqual([parse(b)["metadata"]["name"] for b in self.k8s.posted], [f"{run}-{p}" for p in ("queue", "producer", "senders")])
        self.assertIn(f"127.0.0.1:{self.port}", self.k8s.posted[2])
        self.assertIn('"--n=50"', self.k8s.posted[1])
        self.assertEqual(self.db.get("rate"), "50")  # set before the producer starts
        self.assertEqual(self.post("/demo/api/run", {})[0], 409)
        self.assertEqual(len(self.k8s.posted), 3)
        done = {"conditions": [{"type": "Complete", "status": "True"}]}
        self.k8s.jobs[f"{run}-senders"] = parse(self.k8s.posted[2]) | {"status": done}
        self.db.hset("totals", mapping=run_range(server.RUNS[run]["cfg"], 0, 50)._asdict() | {"done": 50})
        for _ in range(100):  # N done: the check, stop, and once the senders Job completes, SHUTDOWN NOSAVE
            if shutdown.called:
                break
            time.sleep(0.05)
        self.assertEqual((server.RUNS[run]["phase"], server.RUNS[run]["check"], self.db.get("stop")), ("Complete", True, "1"))
        shutdown.assert_called_once_with(nosave=True)

    def test_the_controller_scales_by_the_offered_rate_or_a_full_queue_and_stops_at_n(self):
        c = server.Config(**D | {"n": 20, "senders": 2, "mean_us": 1_000_000, "attempts": 3, "capacity": 6})
        r, run = self.live(cfg=c), "sms-20261010-080000"
        self.k8s.pods[f"{run}-senders"] = [pod(f"{run}-senders-a"), pod(f"{run}-senders-b", "Pending")]
        self.assertFalse(self.step(run))  # no stream, no group and no rate key yet: everything reads 0
        self.assertEqual((r["depth"], r["pending"], r["lambda_in"], r["lambda_offered"], r["P"]), (0, 0, 0, 0, 1))
        self.db.xgroup_create("sms", "senders", "0", mkstream=True)
        for i in range(10):
            self.db.xadd("sms", {"id": i, "body": "x", "created_us": 0})
        self.db.mset({"made": 10, "rate": 10})
        self.assertFalse(self.step(run))  # 10 msg/s offered, no done yet: E[tau] from the config
        tau = server.mean_tau_s(c)
        self.assertGreater(tau, c.mean_us / 1e6)  # the retries and their backoff count
        p = math.ceil(10 * tau / 2)  # Little's law: L = lambda E[tau] busy senders, M = 2 a pod
        self.assertEqual((r["depth"], r["pending"], r["P"], r["lambda_offered"], r["tau_ms"]), (10, 0, p, 10, round(tau * 1e3, 3)))
        self.assertAlmostEqual(r["lambda_in"], 10, delta=0.5)
        self.assertEqual(self.k8s.patched, [(f"{run}-senders", "application/merge-patch+json", {"spec": {"parallelism": p}})])
        me = f"{run}-senders-a-0"
        got = self.db.xreadgroup("senders", me, {"sms": ">"}, count=5)[0][1]
        mine = Summary()
        for entry, f in got[:2]:  # two commits; three messages are still in hand
            s = deliver(c, int(f["id"]))[1]
            mine += s
            self.db.eval(COMMIT, 2, "sms", "totals", entry, *s)
        self.db.eval(COMMIT, 2, "sms", "totals", got[0][0], *s)  # a second commit of one entry counts nothing
        self.db.hset(f"snap:{me}", mapping=mine._asdict())
        self.db.set("rate", 1)  # the offered rate falls below C queued: fewer pods, down to the floor of one
        self.assertFalse(self.step(run))
        self.assertEqual((r["depth"], r["pending"], r["totals"]["done"], r["lambda_in"], r["lambda_offered"]), (5, 3, 2, 0, 1))
        self.assertEqual(r["P"], max(1, math.ceil(1 * mine.time_us / 2 / 1e6 / 2)))
        self.assertAlmostEqual(r["lambda_out"], 2, delta=0.1)
        self.assertEqual(r["totals"], mine._asdict() | {"done": 2})
        self.assertEqual(r["consumers"], [{"pod": f"{run}-senders-a", "phase": "Running", **mine._asdict()},
                                          {"pod": f"{run}-senders-b", "phase": "Pending", **Summary()._asdict()}])
        self.assertEqual(r["busy"], round(r["lambda_out"] * mine.time_us / 2 / 1e6, 2))
        for i in (10, 11):  # queued 7 >= C 6 at 1 msg/s: Little's law says 1 pod, the full queue adds one every T
            self.db.xadd("sms", {"id": i, "body": "x", "created_us": 0})
        p = r["P"]
        self.assertFalse(self.step(run))
        self.assertEqual((r["depth"], r["P"], math.ceil(1 * mine.time_us / 2 / 1e6 / 2)), (7, p + 1, 1))
        self.db.set("rate", 0)  # the closed batch: still at C, so one pod more every T
        self.assertFalse(self.step(run))
        self.assertFalse(self.step(run))
        self.assertEqual(r["P"], p + 3)
        self.db.xreadgroup("senders", me, {"sms": ">"}, count=1)  # queued 6, still at C: one more
        self.assertFalse(self.step(run))
        self.assertEqual((r["depth"], r["P"]), (6, p + 4))
        self.db.xreadgroup("senders", me, {"sms": ">"}, count=1)  # queued 5 < C: P holds
        self.assertFalse(self.step(run))
        self.assertEqual((r["depth"], r["P"]), (5, p + 4))
        self.db.hset("totals", mapping=run_range(c, 0, 20)._asdict() | {"done": 20})
        self.assertTrue(self.step(run))  # done == N: the check against the pure fold
        self.assertEqual((r["phase"], r["check"], r["final"]), ("Complete", True, run_range(c, 0, 20)._asdict()))
        r2 = self.live("sms-20261010-090000", cfg=c)
        self.db.hincrby("totals", "sent", 1)  # a count the fold does not have
        self.assertTrue(self.step(r2["run"]))
        self.assertFalse(r2["check"])

    def test_rate_and_scale_steer_the_live_run(self):
        self.assertEqual(self.post("/demo/api/rate", {"rate": 5})[0], 409)  # no run is running
        self.assertEqual(self.post("/demo/api/scale", {})[0], 409)
        r = self.live(cfg=server.Config(**D | {"n": 6000}), p=3)
        for bad in (-1, 2001, 2.5, "9", 9, None):  # 9 msg/s: 6000 messages take more than 600 s
            self.assertEqual(self.post("/demo/api/rate", {"rate": bad})[0], 400, bad)
        status, body = self.post("/demo/api/rate", {"rate": 50})
        self.assertEqual((status, body["rate"], self.db.get("rate")), (200, 50, "50"))
        self.assertEqual(self.post("/demo/api/rate", {"rate": 0})[1]["rate"], 0)  # 0: the closed batch
        status, body = self.post("/demo/api/scale", {})  # one pod fewer
        self.assertEqual((status, body["P"], body["floor"]), (200, 2, 2))
        self.assertEqual(self.k8s.patched[-1][2], {"spec": {"parallelism": 2}})
        for _ in range(3):
            self.post("/demo/api/scale", {"delta": -1})
        self.assertEqual((r["P"], r["floor"]), (1, 1))  # never below one pod
        self.assertEqual(self.post("/demo/api/scale", {"delta": 2})[1]["P"], 3)
        self.assertEqual(self.post("/demo/api/scale", {"delta": "x"})[0], 400)

    def test_halt_stops_the_run_on_the_cluster_with_its_partial_totals_and_no_check(self):
        run, shutdown = "sms-20261010-080000", self.enterContext(mock.patch.object(redis.Redis, "shutdown"))
        self.k8s.pods[f"{run}-queue"] = [pod("q", ip="127.0.0.1")]
        self.assertEqual(self.post("/demo/api/halt?run=" + run, {})[0], 409)  # nothing is running
        with mock.patch.object(server, "AUD", ["guest", "owner"]), mock.patch.object(server, "TEAM", TEAM), \
                mock.patch.object(pyjwt.PyJWKClient, "fetch_data", return_value=JWKS), mock.patch.object(server, "OWNERS", {"jess@example.org"}):
            as_ = lambda email: {"Content-Type": "application/json", "Cf-Access-Jwt-Assertion": jwt("guest", email=email)}
            self.assertEqual(self.req("POST", "/demo/api/run", b'{"n": 50, "interval_ms": 100}', as_("jess@example.org"))[0], 201)
            for _ in range(100):
                if server.RUNS[run]["phase"] == "Running" and self.k8s.patched:
                    break
                time.sleep(0.05)
            self.assertEqual(self.k8s.patched, [(f"{run}-senders", "application/merge-patch+json",
                                                 {"spec": {"parallelism": 1}, "metadata": {"annotations": {"adi-sms/started-by": "jess@example.org"}}})])
            self.db.hset("totals", mapping={"sent": 9, "failed": 1, "attempts": 11, "time_us": 1000, "done": 10})
            time.sleep(0.3)  # control steps read the partial totals
            self.assertEqual(self.req("POST", "/demo/api/halt?run=sms-other", b"{}", as_("guest@example.com"))[0], 409)
            status, _, body = self.req("POST", f"/demo/api/halt?run={run}", b"{}", as_("guest@example.com"))
            got = json.loads(body)
            self.assertEqual((status, got["phase"], got["started_by"], got["halted_by"]), (200, "Halted", "j***@example.org", "g***@example.com"))
            self.assertEqual(self.k8s.patched[-1][2], {"spec": {"parallelism": 0}, "metadata": {"annotations": {"adi-sms/halted-by": "guest@example.com"}}})
            self.assertEqual((self.db.get("halt"), self.db.get("stop")), ("1", "1"))
            self.k8s.jobs[f"{run}-senders"]["status"] = {"conditions": [{"type": "Complete", "status": "True"}]}  # pods exit 0
            for _ in range(100):  # the pipeline stops its steps, then the drain ends the queue
                if shutdown.called:
                    break
                time.sleep(0.05)
            r = server.RUNS[run]
            self.assertEqual((r["phase"], r["P"], r["final"], "check" in r, r["totals"]["done"]), ("Halted", 0, None, False, 10))
            self.assertEqual(len([p for p in self.k8s.patched if p[2]["spec"]["parallelism"]]), 1)  # no step scaled it back up
            self.assertEqual(self.req("POST", "/demo/api/rate", b'{"rate": 5}', as_("jess@example.org"))[0], 409)  # no more steering
            runs = json.loads(self.req("GET", "/demo/api/runs", headers=as_("jess@example.org"))[2])
            self.assertEqual((runs[0]["phase"], runs[0]["started_by"], runs[0]["halted_by"]), ("Halted", "jess@example.org", "guest@example.com"))
            server.RUNS.clear()  # after a web restart the Job's annotations say the same
            runs = json.loads(self.req("GET", "/demo/api/runs", headers=as_("x@y.example"))[2])
            self.assertEqual((runs[0]["phase"], runs[0]["started_by"], runs[0]["halted_by"]), ("Halted", "j***@example.org", "g***@example.com"))

    def test_state_and_runs_show_this_servers_runs_then_older_ones(self):
        old = parse(server.render("senders", "sms-20261009-120000", IMAGE=IMAGE, P=4, QUEUE="q", FLAGS=server.flags(DEFAULTS)))
        self.k8s.jobs = {"sms-20261009-120000-senders": old | {"status": {"conditions": [{"type": "Complete", "status": "True"}]}},
                         "sms-20261009-120000-queue": parse(server.render("queue", "sms-20261009-120000", IMAGE=IMAGE, P=1, QUEUE="", FLAGS="")),
                         "other": old | {"metadata": old["metadata"] | {"name": "other"}}}
        s = json.loads(self.req("GET", "/demo/api/state")[2])  # only the older run: read back from its senders Job
        self.assertEqual((s["run"], s["phase"], s["P"], s["params"], s["final"]), ("sms-20261009-120000", "Complete", 4, D, None))
        r = self.live()
        r |= {"depth": 3, "pending": 2}
        s = json.loads(self.req("GET", "/demo/api/state")[2])  # the newest run, as its pipeline last saw it
        self.assertEqual((s["run"], s["depth"], s["pending"], s["phase"]), (r["run"], 3, 2, "Running"))
        self.assertFalse({"db", "cfg", "image", "queue", "t"} & set(s))  # no client, no pod address
        runs = json.loads(self.req("GET", "/demo/api/runs")[2])
        self.assertEqual([(x["run"], x["phase"]) for x in runs], [(r["run"], "Running"), ("sms-20261009-120000", "Complete")])
        self.assertEqual(json.loads(self.req("GET", "/demo/api/state?run=sms-20261009-120000")[2])["P"], 4)
        err = urllib.error.HTTPError("u", 404, "nf", {}, None)
        self.addCleanup(err.close)
        with mock.patch.object(server, "kube", side_effect=err):
            self.assertEqual(self.req("GET", "/demo/api/state?run=sms-x")[0], 404)
        with mock.patch.object(server, "kube", wraps=self.k8s) as k:  # a name that is not a run reads sms-*-senders
            self.assertEqual(self.req("GET", "/demo/api/state?run=other")[0], 502)
            self.assertTrue(k.call_args_list[-1].args[1].endswith("/jobs/sms-other-senders"))

    def test_a_running_run_from_another_web_pod_is_adopted_finished_and_drained(self):
        run, shutdown = "sms-20261009-120000", self.enterContext(mock.patch.object(redis.Redis, "shutdown"))
        c = server.Config(**D | {"n": 30, "workers": 2})
        self.k8s.pods[f"{run}-queue"] = [pod("q", ip="127.0.0.1")]
        for path in ("/demo/api/runs", f"/demo/api/state?run={run}"):  # a listing, or an open page's next poll, adopts it
            server.RUNS.clear(), self.db.flushall(), shutdown.reset_mock()
            self.k8s.jobs[f"{run}-senders"] = parse(server.render("senders", run, IMAGE=IMAGE, P=3, QUEUE="q", FLAGS=server.flags(c)))
            self.db.mset({"made": 12, "rate": 40})
            self.db.hset("totals", "done", 5)
            got = json.loads(self.req("GET", path)[2])
            got = got[0] if isinstance(got, list) else got
            self.assertEqual((got["run"], got["P"], got["params"]["n"]), (run, 3, 30))
            for _ in range(100):
                if server.RUNS[run]["phase"] == "Running":
                    break
                time.sleep(0.05)
            r = server.RUNS[run]
            self.assertEqual((r["phase"], r["made"], r["totals"]["done"], r["floor"]), ("Running", 12, 5, 2))  # min(P 3, workers 2)
            self.assertEqual((self.k8s.posted, self.db.get("rate")), ([], "40"))  # no new Jobs; the live rate stays
            self.assertEqual(self.post("/demo/api/run", {})[0], 409)  # still one run at a time
            self.assertEqual(self.post("/demo/api/rate", {"rate": 40})[0], 200)  # and its controls answer again
            self.k8s.jobs[f"{run}-senders"]["status"] = {"conditions": [{"type": "Complete", "status": "True"}]}
            self.db.hset("totals", mapping=run_range(c, 0, 30)._asdict() | {"done": 30})
            for _ in range(100):  # it ends like any run: the check, stop, then SHUTDOWN NOSAVE
                if shutdown.called:
                    break
                time.sleep(0.05)
            self.assertEqual((r["phase"], r["check"], self.db.get("stop")), ("Complete", True, "1"))
            self.assertEqual(len([x for x in json.loads(self.req("GET", "/demo/api/runs")[2]) if x["run"] == run]), 1)

    def test_a_failed_producer_or_a_lost_queue_fails_the_run_at_once(self):
        run, shutdown = "sms-20261010-080000", self.enterContext(mock.patch.object(redis.Redis, "shutdown"))
        job = lambda part, t: {"metadata": {"name": f"{run}-{part}"}, "status": {"conditions": [{"type": t, "status": "True"}]}}
        self.k8s.pods[f"{run}-queue"] = [pod("q", ip="127.0.0.1")]
        self.assertEqual(self.post("/demo/api/run", {"n": 50, "interval_ms": 100})[0], 201)
        self.k8s.jobs = {f"{run}-producer": job("producer", "Complete")}  # it made N: the run goes on
        for _ in range(100):
            if server.RUNS[run]["phase"] != "Starting":
                break
            time.sleep(0.05)
        time.sleep(0.3)  # three control steps
        self.assertEqual(server.RUNS[run]["phase"], "Running")
        self.k8s.jobs = {f"{run}-producer": job("producer", "Failed")}  # backoffLimit 0: done never reaches N
        for _ in range(100):
            if shutdown.called:
                break
            time.sleep(0.05)
        self.assertEqual((server.RUNS[run]["phase"], server.RUNS[run]["error"], self.db.get("stop")),
                         ("Failed", "RuntimeError: the producer Job ended before N were done", "1"))
        self.assertEqual(json.loads(self.req("GET", "/demo/api/runs")[2])[0]["phase"], "Failed")  # the slot is free
        for part, t in (("queue", "Complete"), ("queue", "Failed"), ("senders", "Failed")):  # SHUTDOWN, a lost pod, OOM
            self.live()
            self.k8s.jobs = {f"{run}-{part}": job(part, t)}
            with self.assertRaisesRegex(RuntimeError, f"the {part} Job ended"):
                self.step(run)

    def test_metrics_are_the_running_runs_and_nothing_at_rest(self):
        status, h, body = self.req("GET", "/metrics")  # no run yet: an empty exposition
        self.assertEqual((status, h["Content-Type"], body), (200, "text/plain; version=0.0.4; charset=utf-8", b""))
        r = self.live()
        r |= {"depth": 4, "pending": 3, "lambda_offered": 20.0, "lambda_in": 9.5, "lambda_out": 8.0, "busy": 0.8, "P": 2,
              "consumers": [{"pod": "a", "phase": "Running"}, {"pod": "b", "phase": "Pending"}],
              "totals": {"sent": 40, "failed": 4, "attempts": 44, "time_us": 44000, "done": 44}}
        lines = self.req("GET", "/metrics")[2].decode().splitlines()
        types = [x.split()[2] for x in lines if x.startswith("# TYPE")]
        self.assertEqual(types, ["sms_depth", "sms_pending", "sms_rate_offered", "sms_rate_in", "sms_rate_out", "sms_busy", "sms_parallelism",
                                 "sms_consumers", "sms_sent", "sms_failed", "sms_attempts", "sms_time_us"])
        self.assertTrue(all(x.endswith(" gauge") for x in lines if x.startswith("#")))
        got = {k.split("{")[0]: v for k, v in (x.rsplit(" ", 1) for x in lines if not x.startswith("#"))}
        self.assertEqual(got, {"sms_depth": "4", "sms_pending": "3", "sms_rate_offered": "20.0", "sms_rate_in": "9.5", "sms_rate_out": "8.0", "sms_busy": "0.8",
                               "sms_parallelism": "2", "sms_consumers": "1", "sms_sent": "40", "sms_failed": "4",
                               "sms_attempts": "44", "sms_time_us": "44000"})
        self.assertIn(f'sms_depth{{run="{r["run"]}"}} 4', lines)
        r["phase"] = "Complete"  # at rest no series holds the run's last total
        self.assertEqual(self.req("GET", "/metrics")[2], b"")

    def test_grafana_is_relayed_with_method_path_query_and_body(self):
        seen = []

        class Grafana(BaseHTTPRequestHandler):
            def do_GET(self):
                n = int(self.headers.get("Content-Length") or 0)
                seen.append((self.command, self.path, dict(self.headers), self.rfile.read(n)))
                code = 302 if self.path == "/grafana" else 200
                self.send_response(code)
                self.send_header("Location", "/grafana/") if code == 302 else None
                for v in ("a=1", "b=2"):
                    self.send_header("Set-Cookie", v)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.command == "HEAD" or self.wfile.write(b"ok")
            do_HEAD = do_POST = do_GET
            log_message = lambda *a: None

        up = server.ThreadingHTTPServer(("127.0.0.1", 0), Grafana)
        threading.Thread(target=up.serve_forever, daemon=True).start()
        self.addCleanup(up.server_close), self.addCleanup(up.shutdown)
        with mock.patch.object(server, "GRAFANA", "%s:%d" % up.server_address):
            path = "/grafana/d-solo/sms/sms-runs?orgId=1&panelId=1&kiosk"
            status, h, body = self.req("GET", path, headers={"Cookie": "CF_Authorization=x", "X-Grafana-Org-Id": "1"})
            self.assertEqual((status, body, h["Content-Type"]), (200, b"ok", "application/json"))
            method, upath, hdr, _ = seen[-1]
            self.assertEqual((method, upath, hdr["X-Grafana-Org-Id"], "Cookie" in hdr), ("GET", path, "1", False))
            c = http.client.HTTPConnection(*self.httpd.server_address)  # both Set-Cookie headers come back
            c.request("GET", "/grafana/x")
            self.assertEqual(c.getresponse().headers.get_all("Set-Cookie"), ["a=1", "b=2"])
            c.close()
            q = b'{"queries":[{"refId":"A","expr":"sms_rate"}]}'
            status, _, _ = self.req("POST", "/grafana/api/ds/query?ds_type=prometheus", q, {"Content-Type": "application/json"})
            self.assertEqual((status, seen[-1][0], seen[-1][1], seen[-1][3]), (200, "POST", "/grafana/api/ds/query?ds_type=prometheus", q))
            status, h, _ = self.req("GET", "/grafana")  # Grafana's redirect is passed on, not followed
            self.assertEqual((status, h["Location"], len(seen)), (302, "/grafana/", 4))
            status, h, body = self.req("HEAD", "/grafana/")
            self.assertEqual((status, body, seen[-1][0]), (200, b"", "HEAD"))
            self.assertEqual(self.req("GET", "/grafanax")[0], 404)  # only /grafana and below
            self.assertEqual(len(seen), 5)
        up.shutdown()
        with mock.patch.object(server, "GRAFANA", "%s:%d" % up.server_address):  # a port nothing listens on
            up.server_close()
            status, _, body = self.req("GET", "/grafana/")
            self.assertEqual((status, json.loads(body)["error"]), (502, "grafana: ConnectionRefusedError"))


    def test_an_unreachable_api_server_is_a_502(self):
        with mock.patch.object(server, "kube", side_effect=urllib.error.URLError(TimeoutError("timed out"))):
            for method, path in (("GET", "/demo/api/runs"), ("GET", "/demo/api/state"), ("POST", "/demo/api/run")):
                status, _, body = self.req(method, path, b"{}", {"Content-Type": "application/json"})
                self.assertEqual((status, json.loads(body)["error"]), (502, "kubernetes: URLError"), path)
            self.assertEqual(self.req("GET", "/deck")[0], 200)  # the deck does not need the API
        self.assertEqual(self.k8s.posted, [])


if __name__ == "__main__":
    unittest.main()
