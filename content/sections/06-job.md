<!-- .slide: data-state="dense" -->
## Sender loop

| level | queue | senders | command |
|---|---|---|---|
| threads | `queue.Queue(C)` | $M$ threads in one process | `sms run --level thread` |
| processes | `multiprocessing.Queue(C)` | $P$ processes of $M$ threads | `sms run --level process` |
| pods | Valkey stream `sms`, group `senders` | $P$ pods of $M$ threads | `sms consume --queue HOST:PORT` |

::src{ref="Jesssullivan/adi-sms@1b82a33380b486bc8662c8191846b70e21ced22d:src/adi_sms/pipeline.py#L358-L365" label="pipeline.py L358-L365 Pipeline.scale: shrink by a stop to the next senders, grow by cancelling those stops, then spawning"}

```python
    def scale(self, m: int) -> None:  # shrink: the next senders to get stop; grow: cancel those stops, then spawn
        with self.clock.lock:
            if self.closed:
                return
            m = max(m, 1)
            if more := self.q.stop(self.live - m):
                self.spawn(more)
            self.live = m
```

::src{ref="Jesssullivan/adi-sms@1b82a33380b486bc8662c8191846b70e21ced22d:src/adi_sms/pipeline.py#L190-L276" label="pipeline.py: StreamQueue, the pod level"}

--

<!-- .slide: data-state="dense" -->
## Interesting Excerpts

::src{ref="Jesssullivan/adi-sms@1b82a33380b486bc8662c8191846b70e21ced22d:src/adi_sms/pipeline.py#L306-L309" label="pipeline.py L306-L309 Producer.run: the schedule restarts only at the start or after the closed batch, then a sleep to the next due time"}

```python
            if (r := self.rate(i)) != last:  # the schedule restarts at now only at the start or after the closed batch
                due, last = (due if last else max(due, self.clock.now())), r
            due += fate.gap_s(self.cfg.seed, i, r)
            self.clock.sleep(max(due - self.clock.now(), 0.0))  # behind the schedule after a wait: no sleep
```

::src{ref="Jesssullivan/adi-sms@1b82a33380b486bc8662c8191846b70e21ced22d:src/adi_sms/pipeline.py#L348-L353" label="pipeline.py L348-L353 Pipeline.spawn: at the thread level each sender is one thread, and all M share one LocalQueue, a queue.Queue of C"}

```python
    def spawn(self, k: int) -> None:  # k more senders: k threads, or one process running k sender threads
        names = [f"s{j}" for j in range(self.spawned, self.spawned + k)]
        self.spawned += k
        if self.level == "thread":
            for name in names:
                self.clock.spawn(Sender(self.q, self.cfg, self.clock, name).run)
```

::src{ref="Jesssullivan/adi-sms@1b82a33380b486bc8662c8191846b70e21ced22d:src/adi_sms/pipeline.py#L289-L292" label="pipeline.py L289-L292 Sender.run: one blocking loop of get, send and commit; only a new commit counts"}

```python
        while (msg := self.q.get(self.name)) is not None:
            s = self.gateway.send(msg)
            if self.q.done(self.name, msg, s):  # a message another sender committed first is not this one's
                self.total += s
```

::src{ref="Jesssullivan/adi-sms@1b82a33380b486bc8662c8191846b70e21ced22d:src/adi_sms/pipeline.py#L332-L335" label="pipeline.py L332-L335 work: each of the P worker processes runs M sender threads on one ProcQueue, a multiprocessing.Queue of C"}

```python
def work(q: ProcQueue, cfg: Config, names: list[str]) -> None:  # one worker process: a sender thread per name
    clock = Clock()
    for t in [clock.spawn(Sender(q, cfg, clock, name).run) for name in names]:
        t.join()
```

--

<!-- .slide: data-state="dense" -->
## Interesting Excerpts

::src{ref="Jesssullivan/adi-sms@1b82a33380b486bc8662c8191846b70e21ced22d:src/adi_sms/__main__.py#L35-L39" label="__main__.py L35-L39 consume: each of the P pods runs M sender threads on one StreamQueue, the Valkey stream sms"}

```python
def consume(cfg: Config, addr: str, name: str, lease_ms: int) -> None:  # M sender threads on the stream until stop
    q = StreamQueue(client(addr), cfg.capacity, lease_ms)
    signal.signal(signal.SIGTERM, lambda *_: setattr(q, "stopping", q.stopping or 143))  # 128 + SIGTERM: scaled down
    senders = [Sender(q, cfg, q.clock, f"{name}-{k}") for k in range(cfg.senders)]
    threads = [q.clock.spawn(s.run) for s in senders]
```

::src{ref="Jesssullivan/adi-sms@1b82a33380b486bc8662c8191846b70e21ced22d:src/adi_sms/pipeline.py#L224-L230" label="pipeline.py L224-L230 StreamQueue.get: an expired lease first, else one new entry"}

```python
        while not self.stopping:
            got = self.r.xautoclaim("sms", "senders", name, self.lease, "0-0", count=1)[1]  # a lease ran out
            if not got:
                got = (self.r.xreadgroup("senders", name, {"sms": ">"}, count=1, block=1000) or [[None, []]])[0][1]
            if got:
                self.held[name], f = got[0]
                return Message(int(f["id"]), f["body"].encode(), int(f["created_us"]))
```

::src{ref="Jesssullivan/adi-sms@1b82a33380b486bc8662c8191846b70e21ced22d:src/adi_sms/commit.lua#L1-L8" label="commit.lua L1-L8: the ack, the count and the delete run as one script"}

```lua
if redis.call('XACK', KEYS[1], 'senders', ARGV[1]) == 0 then return 0 end -- not new: count nothing
redis.call('HINCRBY', KEYS[2], 'sent', ARGV[2])
redis.call('HINCRBY', KEYS[2], 'failed', ARGV[3])
redis.call('HINCRBY', KEYS[2], 'attempts', ARGV[4])
redis.call('HINCRBY', KEYS[2], 'time_us', ARGV[5])
redis.call('HINCRBY', KEYS[2], 'done', 1)
redis.call('XDEL', KEYS[1], ARGV[1])
return 1
```

--

<!-- .slide: data-state="dense" -->
## Exactly once from at least once

| at least once | exactly once |
|---|---|
| a pod dies with a message in hand | `XAUTOCLAIM` gives it to a live sender after the lease |
| the redelivered message is sent again | the fate is pure, so its Summary is the same |
| its commit runs a second time | `XACK` returns 0, so nothing is counted |
| a lower `parallelism` sends SIGTERM | the sender commits, then exits 143 |

::src{ref="Jesssullivan/adi-sms@1b82a33380b486bc8662c8191846b70e21ced22d:src/adi_sms/commit.lua#L1-L8" label="commit.lua: the count only on a new ack"}
::src{ref="https://kubernetes.io/docs/concepts/workloads/controllers/job/#pod-failure-policy" label="Kubernetes: Pod failure policy"}
