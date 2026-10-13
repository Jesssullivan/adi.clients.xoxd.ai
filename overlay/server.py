"""adi.clients.xoxd.ai in one process: the deck, /presenter's notes, /demo runs of the core as three Kubernetes Jobs (a
queue, a producer and the senders, whose parallelism this server's controller sets), their progress at /metrics for
Prometheus, and /grafana relayed to the overlay's Grafana."""

import contextlib, functools, http.client, json, math, mimetypes, os, re, ssl, threading, time, urllib.parse, urllib.request, warnings  # noqa: E401
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import jwt
import redis
from adi_sms.fate import PARAMS, Config, Summary, run_range, __file__ as FATE
from adi_sms.pipeline import mean_tau_s

ENV = os.environ.get
DECK, NOTES = Path(ENV("ADI_DECK", "/srv/deck")).resolve(), Path(ENV("ADI_NOTES", "/srv/notes/notes.json"))
DEPLOY = Path(ENV("ADI_DEPLOY", "/deploy"))  # the pinned core's queue.yaml, producer.yaml and senders.yaml
SPEC, SA, TYPES = Path(FATE).with_name("spec.json"), Path("/var/run/secrets/kubernetes.io/serviceaccount"), mimetypes.MimeTypes()
CLOSE_AT, AFTER_CLOSE = datetime(2026, 10, 26, 21, tzinfo=UTC).timestamp(), "https://github.com/Jesssullivan"
CAP = {k: int(ENV(k, d)) for k, d in (("P_MAX", 10), ("M_MAX", 100), ("N_MAX", 10**6), ("MAKESPAN_S", 600), ("RATE_MAX", 2000))}
QPORT = 6379  # every queue pod's valkey-server port
JOBS, PODS, KEPT = "/apis/batch/v1/namespaces/{ns}/jobs", "/api/v1/namespaces/{ns}/pods", "/api/v1/namespaces/{ns}/configmaps/sms-runs"
LOCK, RUNS = threading.Lock(), {}  # one create, rate, scale, halt or scaling patch at a time; run -> its latest view
SHOWN = ("run", "created", "phase", "error", "P", "floor", "rate", "params", "depth", "pending", "lambda_offered", "lambda_in",
         "lambda_out", "busy", "tau_ms", "totals", "made", "consumers", "final", "check", "started_by", "halted_by")  # state()
GAUGES = {"depth": "depth", "pending": "pending", "rate_offered": "lambda_offered", "rate_in": "lambda_in",
          "rate_out": "lambda_out", "busy": "busy", "parallelism": "P"}  # /metrics name -> state() key; then sms_consumers and the four totals
GRAFANA = ENV("ADI_GRAFANA", "grafana:3000")  # the relay drops these headers both ways; Grafana needs no cookie
HOP = {"connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "content-length", "cookie"}
CSP = "frame-ancestors 'self'; frame-src 'self' https://www.youtube-nocookie.com; img-src 'self' data: https://i.ytimg.com"  # the deck frames /demo; the video's hosts
# Who can start a run on the cluster, from the outside in: (1) Cloudflare Access at the edge admits only the allowed
# identities, through One-time PIN or the tailnet's tsidp IdP; (2) the namespace NetworkPolicy lets only the cloudflared
# tunnel pods reach this server; (3) access() checks the Access JWT again against the team's keys and the app's audience,
# so a request that skipped the edge is refused, and its email names who starts or halts a run; (4) create() caps P, M,
# N, the rate, the makespan and the slowest message, one run at a time; (5) the ResourceQuota caps pods, CPU and memory.
TEAM, AUD = ENV("ACCESS_TEAM", ""), ENV("ACCESS_AUD", "").split(",")  # the guest app's audience, then the owner app's
OWNERS = set(ENV("OWNER_EMAILS", "").lower().split(",")) - {""}  # they see who started or halted a run in full
OPEN = ("/healthz", "/metrics")  # the probe and the Prometheus scrape, from the namespace
certs = functools.cache(lambda team: jwt.PyJWKClient(team + "/cdn-cgi/access/certs", cache_keys=True, timeout=10))
now = lambda: float(ENV("ADI_NOW") or time.time())  # ADI_NOW (epoch seconds) moves the clock in tests
fresh = lambda c: {"phase": "Starting", "cfg": c, "rate": c.rate, "t": time.monotonic(), "made": 0, "consumers": [], "final": None,
                   "totals": dict.fromkeys((*Summary._fields, "done"), 0)}  # a run before its first control step

def access(token: str, path: str) -> str:  # an RS256 JWT from TEAM for this path's app: its email, else PyJWTError
    if AUD == ["off"]:  # kind: no Access, no identity
        return ""
    key = certs(TEAM).get_signing_key_from_jwt(token).key  # Cloudflare rotates its keys: an unseen kid refetches the set
    return jwt.decode(token, key, algorithms=["RS256"], audience=AUD[path.startswith("/presenter")], issuer=TEAM, leeway=60,
                      options={"require": ["exp", "iss", "aud"]}).get("email", "")

def mask(o, who: str | None):  # who started or halted a run: in full to an owner, else j***@domain
    return [mask(x, who) for x in o] if isinstance(o, list) else o | {k: o[k] if (who or "").lower() in OWNERS else
        re.sub(r"^(.)[^@]*", r"\1***", o[k]) for k in ("started_by", "halted_by") if isinstance(o, dict) and o.get(k)}

def kube(method: str, path: str, body: str = "", ctype: str = "application/yaml"):  # re-reads the rotating token
    ns, tok = ((SA / f).read_text().strip() for f in ("namespace", "token"))
    hdr = {"Authorization": f"Bearer {tok}", "Content-Type": ctype, "Accept": "application/json"}
    req = urllib.request.Request("https://kubernetes.default.svc" + path.format(ns=ns), body.encode() or None, hdr, method=method)
    with urllib.request.urlopen(req, context=ssl.create_default_context(cafile=SA / "ca.crt"), timeout=10) as r:
        return json.load(r)

def pods(job: str) -> list[dict]:  # the pods of one Job, oldest first
    items = kube("GET", PODS + "?labelSelector=batch.kubernetes.io%2Fjob-name%3D" + urllib.parse.quote(job))["items"]
    return sorted(items, key=lambda q: q["metadata"]["creationTimestamp"])

def ended(job: dict) -> list[str]:  # the Job's true conditions: Complete, Failed, ...
    return [c["type"] for c in job.get("status", {}).get("conditions", []) if c["status"] == "True"]

def describe(job: dict) -> dict:  # a run from before this server started, read back from its senders Job
    m, s, words = job["metadata"], job["spec"], " ".join(job["spec"]["template"]["spec"]["containers"][0]["command"])
    ok, a = ended(job), m.get("annotations") or {}  # who started and halted it, as the pipeline patched them in
    return {"run": m["name"].removesuffix("-senders"), "created": m["creationTimestamp"], "P": s["parallelism"],
            "phase": "Halted" if "adi-sms/halted-by" in a else next((t for t in ("Complete", "Failed") if t in ok), "Running"),
            "final": None, "started_by": a.get("adi-sms/started-by"), "halted_by": a.get("adi-sms/halted-by"),
            "params": {f: int(x[1]) for f in PARAMS if (x := re.search(rf"--{f.replace('_', '-')}=(\d+)", words))}}

def runs() -> list[dict]:  # newest first, a row a run: as its pipeline here sees it, else its last view in sms-runs, else its senders Job
    items = kube("GET", JOBS)["items"]
    old = [describe(j) for j in items if re.fullmatch(r"sms-[\d-]+-senders", j["metadata"]["name"])]
    for j in (j for j in old if j["phase"] == "Running" and j["run"] not in RUNS):  # one another web pod started
        adopt(j, next(i for i in items if i["metadata"]["name"] == j["run"] + "-senders"))
    return sorted({j["run"]: j for j in (*old, *(recent() or []), *map(view, RUNS.values()))}.values(), key=lambda j: j["run"], reverse=True)

def recent() -> list[dict] | None:  # the last 20 ended runs, newest first, as pipeline() kept them in ConfigMap sms-runs
    with contextlib.suppress(Exception):  # its manifest has no data, so a deploy leaves them in place
        return json.loads(kube("GET", KEPT).get("data", {}).get("runs", "[]"))
    warnings.warn("ConfigMap sms-runs is missing or unreadable, so the runs list has no history")  # Python prints it once

def adopt(d: dict, job: dict) -> None:  # resume its control steps here, so it ends, drains and stops blocking new runs
    c = Config(**{f: v["default"] for f, v in PARAMS.items()} | d["params"])
    r = d | fresh(c) | {"image": job["spec"]["template"]["spec"]["containers"][0]["image"], "floor": min(c.workers, d["P"]), "adopted": True}
    if RUNS.setdefault(d["run"], r) is r:  # one adoption, however many requests list the runs at once
        threading.Thread(target=pipeline, args=(d["run"],), daemon=True).start()

def render(part: str, run: str, **subs: object) -> str:  # one of the core's templates, as its `just render` does
    subs |= {"JOB": run, "PULL_SECRET": ENV("PULL_SECRET", "")}  # the template appends -queue, -producer or -senders
    text = re.sub(r"\$\{(\w+)\}", lambda m: str(subs[m[1]]), (DEPLOY / f"{part}.yaml").read_text())  # KeyError: one it lacks
    return "".join(x for x in text.splitlines(True) if not re.match(r" *#", x) and 'name: ""' not in x)

def flags(c: Config) -> str:  # every Config field as a flag, in the templates' `, "flag"` form
    return "".join(f', "--{f.replace("_", "-")}={getattr(c, f)}"' for f in PARAMS)

def create(body: dict, who: str) -> dict:  # the queue Job now; the pipeline thread waits for its address, starts the rest
    if extra := set(body) - set(PARAMS):  # a body that is not an object: TypeError
        raise ValueError(f"unknown fields {sorted(extra)}")
    c = Config(**{f: body.get(f, v["default"]) for f, v in PARAMS.items()})  # bounds-checked
    worst_us = c.attempts * 37 * c.mean_us + c.backoff_us * ((1 << (c.attempts - 1)) - 1)  # 37 > -ln(2^-53): the longest draw
    if c.workers > CAP["P_MAX"] or c.senders > CAP["M_MAX"] or c.rate > CAP["RATE_MAX"] or c.n > CAP["N_MAX"] or (
            c.n * mean_tau_s(c) > CAP["MAKESPAN_S"] * c.workers * c.senders) or (
            c.rate and c.n > CAP["MAKESPAN_S"] * c.rate) or worst_us > 30e6:  # 30 s: the core's lease on a message in hand
        raise ValueError(f"hosted runs keep P <= {CAP['P_MAX']}, M <= {CAP['M_MAX']}, rate <= {CAP['RATE_MAX']} msg/s, "
                         f"N <= {CAP['N_MAX']}, N E[tau] / (P M) and N / rate <= {CAP['MAKESPAN_S']} s, each message in the 30 s lease")
    image = kube("GET", PODS + "/" + ENV("POD_NAME", ""))["spec"]["containers"][0]["image"]  # every run pod runs it
    run = time.strftime("sms-%Y%m%d-%H%M%S", time.gmtime(now()))
    kube("POST", JOBS, render("queue", run, IMAGE=image, P=c.workers, QUEUE="", FLAGS=""))
    RUNS[run] = fresh(c) | {"run": run, "created": datetime.fromtimestamp(now(), UTC).isoformat(), "image": image,
                            "params": {f: getattr(c, f) for f in PARAMS}, "P": c.workers, "floor": c.workers, "started_by": who}
    threading.Thread(target=pipeline, args=(run,), daemon=True).start()
    return view(RUNS[run])

def pipeline(run: str) -> None:  # the queue's address, the producer and the senders, a control step every T, the drain
    r, c, t0 = RUNS[run], RUNS[run]["cfg"], time.monotonic()
    try:
        for _ in range(120):  # the queue pod's IP, then its first PONG: about 10 s, at most 2 min
            with contextlib.suppress(redis.RedisError, OSError):
                if ip := next((q["status"]["podIP"] for q in pods(f"{run}-queue") if q["status"].get("podIP")), None):
                    (db := redis.Redis(ip, QPORT, socket_timeout=5, decode_responses=True)).ping()
                    break
            time.sleep(1)
        else:
            raise TimeoutError("the queue pod did not answer within 2 min")
        r |= {"db": db, "queue": f"{ip}:{QPORT}"}
        if r.get("adopted"):  # its Jobs exist: the first rates start from the queue's counts
            r["made"], r["totals"]["done"] = int(db.get("made") or 0), int(db.hget("totals", "done") or 0)
        else:
            db.set("rate", c.rate)  # before the producer starts; it re-reads the key before every message
            for part in ("producer", "senders"):
                kube("POST", JOBS, render(part, run, IMAGE=r["image"], P=r["P"], QUEUE=r["queue"], FLAGS=flags(c)))
            r["started_by"] and patch(run, r["P"], started_by=r["started_by"])  # on the Job, so a restart reads it back
        r["phase"] = "Running"
        while time.monotonic() - t0 < 2 * CAP["MAKESPAN_S"]:  # a run that cannot finish is stopped, not left running
            try:
                if r["phase"] == "Halted" or tick(run):  # a halt ends the steps; the drain below ends the queue
                    return
            except (redis.RedisError, OSError) as e:  # one missed step; the next one measures over the longer gap
                r["error"] = f"{type(e).__name__}: {e}"
            time.sleep(c.interval_ms / 1e3)
        raise TimeoutError(f"the run did not finish within {2 * CAP['MAKESPAN_S']} s")
    except Exception as e:  # the view says why
        r |= {"phase": "Failed", "error": f"{type(e).__name__}: {e}"}
    finally:  # sms-runs keeps this run's last view and the 19 runs before it; if recent() is None, nothing is written
        with LOCK, contextlib.suppress(Exception):
            kube("PATCH", KEPT, json.dumps({"data": {"runs": json.dumps([view(r)] + [k for k in recent() if k["run"] != run][:19])}}), "application/merge-patch+json")
        "db" in r and drain(run)

def tick(run: str) -> bool:  # one control step: read the queue, the totals and the snapshots; scale; True at N done
    r, t, c, db = RUNS[run], time.monotonic(), RUNS[run]["cfg"], RUNS[run]["db"]
    ends = {j["metadata"]["name"]: ended(j) for j in kube("GET", JOBS)["items"]}  # a Job its TTL removed reads as none
    if lost := [p for p in ("queue", "producer", "senders") if (e := ends.get(f"{run}-{p}")) and (p == "queue" or "Failed" in e)]:
        raise RuntimeError(f"the {lost[0]} Job ended before N were done")  # not a missed step: the run fails, then drains
    pipe = db.pipeline(transaction=False).xlen("sms").xpending("sms", "senders").hgetall("totals").get("made").get("rate")
    length, pend, tot, made, rate = (None if isinstance(x, Exception) else x for x in pipe.execute(raise_on_error=False))
    pending, made, offered = (pend or {}).get("pending", 0), int(made or 0), float(rate or 0)  # no group yet: 0
    tot = {f: int((tot or {}).get(f, 0)) for f in (*Summary._fields, "done")}
    s, done, dt = Summary(*(tot[f] for f in Summary._fields)), tot["done"], max(t - r["t"], 1e-3)
    tau = s.time_us / done / 1e6 if done else mean_tau_s(c)  # E[tau] measured; else sum p^j (mu + beta 2^(j-1)), j < A
    lam_in, lam_out = (made - r["made"]) / dt, (done - r["totals"]["done"]) / dt
    pipe, per = db.pipeline(transaction=False), {}
    for k in (keys := list(db.scan_iter("snap:*", count=1000))):
        pipe.hgetall(k)
    for k, v in zip(keys, pipe.execute()):  # snap:<pod>-<k> is sender thread k of that pod
        pod = k.removeprefix("snap:").rsplit("-", 1)[0]
        per[pod] = per.get(pod, Summary()) + Summary(*(int(v.get(f, 0)) for f in Summary._fields))
    consumers = [{"pod": (n := q["metadata"]["name"]), "phase": q["status"].get("phase", "Pending")} |
                 per.get(n, Summary())._asdict() for q in pods(f"{run}-senders")]
    depth = (length or 0) - pending  # queued: lambda_in is clipped at capacity, so the controller reads the offered rate
    want = max(math.ceil(offered * tau / c.senders) if offered else r["P"], r["P"] + 1 if depth >= c.capacity else 0)  # L = lambda E[tau]
    with LOCK:  # a halt between the reads and this patch keeps parallelism 0
        if (target := max(r["floor"], min(want, CAP["P_MAX"]))) != r["P"] and done < c.n and r["phase"] == "Running":
            patch(run, target)
    r |= {"t": t, "made": made, "depth": depth, "pending": pending, "lambda_offered": offered, "rate": round(offered),
          "lambda_in": round(lam_in, 1), "lambda_out": round(lam_out, 1), "busy": round(lam_out * tau, 2),
          "tau_ms": round(tau * 1e3, 3), "totals": tot, "consumers": consumers, "error": None}
    if done < c.n:
        return False
    r |= {"final": s._asdict(), "check": s == run_range(c, 0, c.n), "phase": "Complete"}
    return True

def drain(run: str) -> None:  # stop: the senders exit 0 and their Job completes; then SHUTDOWN, so the queue Job does
    db = RUNS[run]["db"]
    with contextlib.suppress(Exception):
        db.set("stop", "1")
        for _ in range(120):
            if "Complete" in ended(kube("GET", f"{JOBS}/{run}-senders")):
                break
            time.sleep(1)
    with contextlib.suppress(redis.RedisError):
        db.shutdown(nosave=True)

def patch(run: str, p: int, **who: str) -> None:  # parallelism (more pods start, or the newest get SIGTERM), and who
    notes = {"metadata": {"annotations": {f"adi-sms/{k.replace('_', '-')}": v for k, v in who.items()}}} if who else {}
    kube("PATCH", f"{JOBS}/{run}-senders", json.dumps({"spec": {"parallelism": p}} | notes), "application/merge-patch+json")
    RUNS[run]["P"] = p

view = lambda r: {k: r[k] for k in SHOWN if k in r}  # what a page sees: no client, config, image or pod address

def state(run: str) -> dict:  # this server's view of the run, else the one runs() lists, else the run's senders Job
    run = run or next(iter(runs()), {}).get("run") or "sms--"
    listed = {} if run in RUNS else {j["run"]: j for j in runs()}  # runs() adopts a run another web pod started
    if run in RUNS:
        return view(RUNS[run])
    return listed.get(run) or describe(kube("GET", f"{JOBS}/{urllib.parse.quote('sms-' + run.removeprefix('sms-') + '-senders', safe='')}"))

def metrics() -> str:  # the running runs in Prometheus text format: at rest no series holds a run's last numbers
    if not (rs := [r for r in RUNS.values() if r["phase"] == "Running"]):
        return ""
    rows = {g: {r["run"]: r.get(k) or 0 for r in rs} for g, k in GAUGES.items()}
    rows["consumers"] = {r["run"]: sum(q["phase"] == "Running" for q in r["consumers"]) for r in rs}
    rows |= {f: {r["run"]: r["totals"][f] for r in rs} for f in Summary._fields}
    return "".join(f"# TYPE sms_{g} gauge\n" + "".join(f'sms_{g}{{run="{k}"}} {v}\n' for k, v in row.items()) for g, row in rows.items())

class Handler(BaseHTTPRequestHandler):
    def send(self, code: int, body: bytes = b"", ctype: str = "", *raw: tuple[str, str], **hdr: str) -> None:
        self.send_response(code)
        for k, v in (*raw, *({"Content-Type": ctype, "Content-Length": str(len(body))} | hdr).items()):
            v and self.send_header(k.replace("_", "-"), v)
        self.end_headers()
        self.command == "HEAD" or self.wfile.write(body)
    json = lambda self, code, o: self.send(code, json.dumps(mask(o, self.who)).encode(), "application/json", Cache_Control="no-store")
    def file(self, f: Path, code: int = 200, **hdr: str) -> None:  # a .br or .gz sibling when the client takes one
        ctype = TYPES.guess_type(f.name)[0] or "application/octet-stream"
        ctype += "; charset=utf-8" if ctype.startswith("text/") or ctype.endswith(("json", "javascript")) else ""
        ae, cc = self.headers.get("Accept-Encoding", ""), "private, no-cache"
        enc, x = next(((e, f".{e[:2]}") for e in ("br", "gzip") if e in ae and Path(f"{f}.{e[:2]}").exists()), ("", ""))
        cc = "private, max-age=31536000, immutable" if "/_app/immutable/" in f.as_posix() else cc
        hdr = {"Cache_Control": cc, "Content_Encoding": enc, "Vary": "Accept-Encoding", "Content_Security_Policy": CSP} | hdr
        self.send(code, Path(f"{f}{x}").read_bytes(), ctype, **hdr)
    def proxy(self) -> None:  # to Grafana with the method, path, query and body as sent; Access gates the hostname
        if not 0 <= (n := int(self.headers.get("Content-Length") or 0)) <= 2**20: raise ValueError("body > 1 MiB")
        with contextlib.closing(http.client.HTTPConnection(GRAFANA, timeout=30)) as c:
            c.request(self.command, self.path, self.rfile.read(n) or None, {k: v for k, v in self.headers.items() if k.lower() not in HOP})
            r = c.getresponse()
            self.send(r.status, r.read(), "", *((k, v) for k, v in r.getheaders() if k.lower() not in HOP))
    def static(self, path: str, q: str) -> None:  # the deck's build/ (/demo too): /x serves x.html, /d/ d/index.html
        q, t = "?" + q if q else "", (DECK / (rel := urllib.parse.unquote(path).lstrip("/"))).resolve()
        html, index, ok = Path(f"{t}.html"), t / "index.html", t.is_relative_to(DECK)
        if ok and rel.endswith(".html") and t.is_file():  # /x.html -> /x, /d/index.html -> /d/
            return self.send(308, Location="/" + rel.removesuffix(".html").removesuffix("index") + q)
        if ok and rel and (html.is_file() if rel.endswith("/") else index.is_file()):  # /x/ -> /x, /d -> /d/
            return self.send(308, Location="/" + rel.rstrip("/") + "/" * index.is_file() + q)
        f = next((x for x in (t, index, html) if ok and x.is_file()), None)
        self.file(f or DECK / "404.html", 200 if f else 404)
    def post(self, path: str, query: str) -> None:  # JSON only, so a cross-site form cannot start, steer or halt a run
        if self.headers.get_content_type() != "application/json":
            return self.json(415, {"error": "POST takes JSON"})
        if not 0 <= (size := int(self.headers.get("Content-Length") or 0)) <= 4096: raise ValueError("body > 4 KiB")
        body = json.loads(self.rfile.read(size) or b"{}")  # read before the lock, so a slow client blocks no one
        with LOCK:
            if path == "/demo/api/run":  # one run at a time
                busy = any(j["phase"] in ("Starting", "Running") for j in runs())
                return self.json(409, {"error": "a run is already active"}) if busy else self.json(201, create(body, self.who))
            runs()  # adopts a run another web pod started, so its controls answer here
            halt = path == "/demo/api/halt" and urllib.parse.parse_qs(query).get("run", [""])[0]  # halt?run=<run>
            if not (r := next((r for r in RUNS.values() if r["phase"] == "Running"), None)) or halt not in (False, r["run"]):
                return self.json(409, {"error": "no run is running" + (f" as {halt}" if halt else "")})
            if halt:  # stop ends the senders' loops and parallelism 0 sends them SIGTERM; then drain() ends the queue
                r["db"].mset({"halt": 1, "stop": 1})
                r |= {"phase": "Halted", "halted_by": self.who}
                patch(r["run"], 0, halted_by=self.who)
            if path == "/demo/api/rate":  # the live arrival rate, msg/s; the producer reads it before every message
                lam, left = body.get("rate") if isinstance(body, dict) else None, r["params"]["n"] - r["made"]
                if type(lam) is not int or not 0 <= lam <= CAP["RATE_MAX"] or lam and left > CAP["MAKESPAN_S"] * lam:
                    raise ValueError(f"want an integer rate in [0, {CAP['RATE_MAX']}] msg/s with the rest of N "
                                     f"arriving within {CAP['MAKESPAN_S']} s")
                r["db"].set("rate", lam)
                r["rate"] = lam
            elif path == "/demo/api/scale":  # {"delta": -1}: the floor and the pods move now; demand can raise them again
                if type(d := body.get("delta", -1) if isinstance(body, dict) else None) is not int:
                    raise ValueError("want an integer delta")
                r["floor"] = min(max(r["floor"] + d, 1), CAP["P_MAX"])
                patch(r["run"], min(max(r["P"] + d, 1), CAP["P_MAX"]))
            return self.json(200, view(r))
    def route(self, u: urllib.parse.SplitResult) -> None:
        if now() >= CLOSE_AT:  # the close-down, 17:00 EDT on 2026-10-26: every request goes to the GitHub profile
            return self.send(302, Location=AFTER_CLOSE, Cache_Control="no-store")
        try:  # the Access email, "" in kind; None refuses the request
            self.who = "" if u.path in OPEN else access(self.headers.get("Cf-Access-Jwt-Assertion", ""), u.path)
        except Exception:  # a missing, malformed or expired token, or a key Cloudflare does not publish
            self.who = None
        if not (ok := self.who is not None) or u.path == "/healthz":
            return self.send(200, b"ok", "text/plain") if ok else self.json(403, {"error": "no valid Access token"})
        if u.path == "/grafana" or u.path.startswith("/grafana/"):  # served from Grafana's sub-path /grafana
            return self.proxy()
        if self.command == "POST":
            if u.path in (api := ("/demo/api/run", "/demo/api/rate", "/demo/api/scale", "/demo/api/halt")):
                return self.post(u.path, u.query)
            return self.json(404, {"error": f"POST takes {', '.join(api)}"})
        match u.path:  # the raw path: an encoded spelling of notes.json falls through to the static 404
            case "/presenter/notes.json" if NOTES.is_file():  # the notes Secret, under the owner-only Access path
                return self.file(NOTES, Cache_Control="private, no-store", X_Robots_Tag="noindex")
            case "/demo/api/spec":
                return self.json(200, {"params": json.loads(SPEC.read_text())["params"], "caps": CAP})
            case "/demo/api/runs":
                return self.json(200, runs()[:20])
            case "/metrics":  # scraped every 1 s; it reads only what the pipelines last saw, never the cluster
                return self.send(200, metrics().encode(), "text/plain; version=0.0.4; charset=utf-8")
            case "/demo/api/state":
                return self.json(200, state(urllib.parse.parse_qs(u.query).get("run", [""])[0]))
        self.static(u.path, u.query)
    def do_GET(self) -> None:
        try:
            self.route(urllib.parse.urlsplit(self.path))
        except (ValueError, TypeError, AttributeError) as e:
            self.json(400, {"error": str(e)})
        except (OSError, KeyError) as e:  # an HTTPError carries the API's status; anything else is a 502
            api = "grafana" if self.path.startswith("/grafana") else "kubernetes"
            self.json(getattr(e, "code", 502), {"error": f"{api}: {getattr(e, 'code', type(e).__name__)}"})
    do_HEAD, do_POST, timeout, who = do_GET, do_GET, 30, None  # a client that stalls frees its thread after 30 s

if __name__ == "__main__":
    ThreadingHTTPServer(("", int(ENV("PORT", "8080"))), Handler).serve_forever()
