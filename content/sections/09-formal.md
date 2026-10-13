## some formality from a 89,873 foot view, hehe

| check | where | result |
|---|---|---|
| defaults in bounds; worst total below $2^{63}-1$ | `Spec.dhall` asserts | checked when the spec type-checks |
| every reachable state of 378 small shapes | `Model.hs` search | 89,873 states; none breaks a property |
| `UnboundedQueue`: the producer ignores $C$ | mutant | breaks `bounded_memory` in 2 moves |
| `RequeueRetry`: a retry goes back on the queue | mutant | breaks `throughput_law` in 3 moves |
| `DoubleCommit`: the count and the ack are two steps | mutant | breaks `fold_equivalence` in 7 moves |
| `DoubleTake`: a read, then a later pop | mutant | the head is taken twice: breaks `fold_equivalence` in 6 moves |

::src{ref="Jesssullivan/adi-sms@1b82a33380b486bc8662c8191846b70e21ced22d:spec/Spec.dhall#L68-L99" label="Spec.dhall: mutants and asserts"}
::src{ref="Jesssullivan/adi-sms@1b82a33380b486bc8662c8191846b70e21ced22d:docs/03-properties.svx#L27-L31" label="03-properties.svx: the model"}
