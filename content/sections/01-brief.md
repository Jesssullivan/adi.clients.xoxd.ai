## Diagram

::svg{src="01-pipeline"}

::src{ref="Jesssullivan/adi-sms@1b82a33380b486bc8662c8191846b70e21ced22d:spec/Spec.dhall#L23-L40" label="Spec.dhall: the brief, phrase by phrase"}

--

<!-- .slide: data-state="dense" -->
## Param symbols throughout docs, args and frozendict

written with Python 3.15 (which happens to have also been released Oct 9th; find my use of the new and wonderful builtin immutable type  `frozendict` from [PEP 814](https://peps.python.org/pep-0814/)). :-)


If you'd like to dive right into my interpreted solution code, you may want to beeline into the [`./src/adi_sms/`](https://github.com/Jesssullivan/adi-sms/tree/main/src/adi_sms) python package, which is effectively two files, `fate.py` and `pipeline.py`.  

However, I think it'll be more illuminating to start in the [design doc](https://adi.clients.xoxd.ai/docs/design).

### Parameters

| symbol | flag | meaning | default | bounds |
|---|---|---|---|---|
| N | `--n` | messages | 1000 | 0 to 10⁹ |
| s | `--seed` | seeds every random choice | 1 | 0 to 2⁵³ − 1 |
| M | `--senders` | threads per process or pod | 10 | 1 to 10⁴ |
| C | `--capacity` | queue bound | 10 | 1 to 10⁵ |
| μ | `--mean-us` | mean attempt latency (µs) | 10⁵ | 0 to 10⁷ |
| p | `--fail-ppm` | failure probability per attempt (ppm) | 10⁵ | 0 to 10⁶ |
| A | `--attempts` | max attempts per message | 1 | 1 to 10 |
| β | `--backoff-us` | backoff base (µs) | 10⁴ | 0 to 10⁶ |
| T | `--interval-ms` | monitor period (ms) | 1000 | 100 to 60000 |
| λ | `--rate` | arrivals per second (0: closed batch) | 0 | 0 to 10⁶ |
| P | `--workers` | processes or pods | 1 | 1 to 64 |
