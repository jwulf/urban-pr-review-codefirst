# urban-pr-review-codefirst

The **code-first** expression of [urban-pr-review](../urban-pr-review): a durable,
multi-round loop that drives a GitHub PR to convergence against an automated
reviewer, escalating to a human when the reviewer is stuck or a round cap is hit.

The model-first app draws this loop in `convergence-loop.bpmn`. Here the same loop
is written with the `@nanobpm/workflow` declarative surface (`defineFlow`, ADR
0044/0045). The SDK derives the executable BPMN (with DI), the job types, and the
message names — no diagram, no task-type wiring, no correlation plumbing.

## The flow

`workflows/convergence-loop.ts`:

```
loop:
  review-round            (EXTERNAL agent — a coding-agent harness)
  switch status:
    converged  -> persist-converged; break
    addressed  -> if round >= maxRounds:
                     persist-escalation-maxrounds        (fall through)
                  else:
                     persist-round (round+1); wait-review; continue
    default    -> persist-escalation                     (fall through)
  wait-answer             (both escalation paths park here for a human)
```

- **`review-round`** is a `w.task` — an **external** worker. Point a coding-agent
  harness at the job type `convergence-loop:review-round` (e.g. `c8ctl nano hire`).
  The app never hosts or names it; it only owns the durable orchestration around it.
- **`persist-*`** and **`persist-converged`** are `w.run` — app-hosted handlers.
  `persist-round` returns `{ round: round + 1 }`; that return value (not an
  ioMapping) is the loop's only state mutation.
- **`wait-review`** / **`wait-answer`** are `w.signal` — real, engine-visible catch
  events correlated on `prKey`. Both resume at the loop head (`review-round`):
  `wait-review` via an explicit `continue`, `wait-answer` via the loop's natural
  repeat. The two escalation branches converge on the single trailing
  `wait-answer` (step names must be unique, so the signal is not repeated). This
  durable wait is the surface a Temporal-style code-first API cannot draw.

Because every step declares a typed `envelope()` contract, this flow can be
**ejected to model-first** without losing its I/O shapes — they are lifted into
the generated BPMN as `nano:shape` + `io.nanobpm.dataEnvelope` properties.

## Derived names

| Step | Derived job type / message |
| --- | --- |
| `review-round` (external) | `convergence-loop:review-round` |
| `persist-round` | `convergence-loop:persist-round` |
| `persist-escalation` | `convergence-loop:persist-escalation` |
| `persist-escalation-maxrounds` | `convergence-loop:persist-escalation-maxrounds` |
| `persist-converged` | `convergence-loop:persist-converged` |
| `wait-review` (signal) | `convergence-loop:wait-review` |
| `wait-answer` (signal) | `convergence-loop:wait-answer` |

## Run it

Requires a running Nano gateway (default `http://localhost:8080`; override with
`NANOBPMN_BASE_URL`).

```sh
# 1) the worker-host service (deploys the flow, hosts the app-owned w.run workers)
deno task start

# 2) submit a PR (parks after review-round at wait-review or wait-answer)
deno task submit https://github.com/owner/repo/pull/42 5   # 5 = maxRounds

# 3a) nudge a re-review (resumes an instance parked at wait-review)
deno task review-ready owner/repo#42

# 3b) answer an escalation (resumes an instance parked at wait-answer)
deno task answer owner/repo#42 "merge as-is"
```

The reviewer itself is not started by `deno task start` — it is the external
`convergence-loop:review-round` job. Host it with a coding-agent harness so the
automated review is fully decoupled from the durable orchestration.

## Link it into your Nano projects

This is a standalone Deno project. Import it by reference (ADR 0041) so the
console reads it live from this directory:

- In the console **Projects → Import by reference**, point at this folder, or
- drop a `urban-pr-review-codefirst.project-ref.json` in your projects root.
