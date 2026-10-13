## Napkin math

```json
{"sent":893,"failed":107,"attempts":1000,"time_us":99301920}
```

| level | run | equal to `sms fold` when |
|---|---|---|
| threads | `sms run --level thread` | it prints `"check": true` |
| processes | `sms run --level process --workers 4` | it prints `"check": true` |
| pods | `sms produce` and `sms consume` on one stream | the `totals` hash matches |
| mixed fleet | Python and Rust consumers on one stream | the `totals` hash matches |

::src{ref="Jesssullivan/adi-sms@1b82a33380b486bc8662c8191846b70e21ced22d:spec/generated/vectors.json#L366-L382" label="vectors.json: the known answer"}
::src{ref="Jesssullivan/adi-sms@1b82a33380b486bc8662c8191846b70e21ced22d:src/adi_sms/__main__.py#L1-L108" label="__main__.py: sms run, produce, consume and fold"}
::src{ref="https://github.com/Jesssullivan/adi-sms-ports" label="Jesssullivan/adi-sms-ports: the Rust consumer"}

--

<!-- .slide: data-state="dense" -->
## Benching

| `just conform`, 7 configs | runs | rows equal to `sms fold` |
|---|---|---|
| Python, the core's `sms run` | $M$ sender threads | 7 of 7 |
| Rust, tokio | 1, 2 and 8 worker threads | 21 of 21 |
| Haskell, GHC | `+RTS -N1`, `-N2` and `-N8` | 21 of 21 |

::media{src="10-bench.svg" alt="msg/s of the core, Rust, Haskell and textbook runners, with no waits and with μ = 100 ms"}

::src{ref="https://github.com/Jesssullivan/adi-sms-ports/tree/3b6dee6b63f85ce740ae27d80a6fb92d6eeb0a4d/bench" label="adi-sms-ports bench/: the receipts and this chart"}
::src{ref="https://github.com/Jesssullivan/adi-sms-ports/blob/3b6dee6b63f85ce740ae27d80a6fb92d6eeb0a4d/tools/bench.py" label="adi-sms-ports tools/bench.py: the bench code"}

--

<!-- .slide: data-state="dense" -->
## Discussion on traditional MT / non-keyed RNGs

| msg/s on 2x Xeon E5-2630 v3, 2026-10-12 | Python | Rust | Haskell | textbook |
|---|---:|---:|---:|---:|
| no waits: the CPU sets the rate | 8,004 | 1,023,140 | 154,699 | 13,759 |
| $\mu = 100$ ms, $M = 1000$: at most $M/\mu$ = 10,000 msg/s | 5,401 | 7,426 | 7,397 | 6,905 |

| outcome of a send | drawn by |
|---|---|
| core and ports | the keyed fate: the simulated far side and the oracle |
| textbook | a stateful TinyMT32 after each wait, with no oracle |

::svg{src="10-review-dfd"}
