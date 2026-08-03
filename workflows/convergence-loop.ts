import { defineFlow, envelope } from "@nanobpm/urban";
import type { DataLayer, Table } from "@nanobpm/urban";
import type { Escalations, PullRequests, Rounds } from "../app/rows.ts";

// ---------------------------------------------------------------------------
// Persistence (parity with the model-first `urban-pr-review`). The `w.run`
// handlers below are the app-owned record steps — the same writes the sibling
// app makes from `workers/{persist-round,persist-escalation,finalize}` — but
// hosted in-process by `@nanobpm/workflow`'s Worker instead of as standalone
// `defineWorker`s. Data access goes through the Urban typed data layer
// (`DataLayer.table<T>`), not hand-written SQL.
//
// The data layer is provisioned by the Urban runtime (`runFromEnv`) and injected
// via `setPersistData` before the Worker starts, so the thin CLI scripts
// (submit/answer/review-ready) can import this flow to start/signal instances
// without ever touching the DB — only the worker host injects the data layer.
// ---------------------------------------------------------------------------
// The persist handlers below run in-process inside `@nanobpm/workflow`'s Worker
// (not the Urban worker host), so they receive no AppApi. `main.ts` injects the
// Urban data layer here after the app provisions its datasource; `db()` exposes
// the three tables these handlers write, over the injected `DataLayer`.
interface PersistTables {
  rounds: Table<Rounds>;
  escalations: Table<Escalations>;
  pull_requests: Table<PullRequests>;
}
let _data: DataLayer | null = null;
export function setPersistData(d: DataLayer): void {
  _data = d;
}
function db(): PersistTables {
  if (!_data) {
    throw new Error(
      "persist data layer not injected — call setPersistData(app.data) before starting the Worker",
    );
  }
  return {
    rounds: _data.table<Rounds>("rounds", "id"),
    escalations: _data.table<Escalations>("escalations", "id"),
    pull_requests: _data.table<PullRequests>("pull_requests", "pr_key"),
  };
}

const nowTs = (): string => new Date().toISOString();

// The external reviewer harness records its full (byte-capped) stdout on the
// result envelope; keep it for audit so a human can see what the agent did this
// round without re-running it.
const AGENT_RESULT_KEY = "io.nanobpm.agentResult";
function transcriptOf(vars: Record<string, unknown>): string | null {
  const env = vars[AGENT_RESULT_KEY] as { output?: unknown } | undefined;
  return typeof env?.output === "string" ? env.output : null;
}

// ---------------------------------------------------------------------------
// Typed data envelopes (ADR 0045). Each is lifted into the generated BPMN as a
// `nano:shape` + `io.nanobpm.dataEnvelope` property, so this code-first flow can
// be *ejected* to model-first without losing its I/O contracts. `env.type` is a
// phantom type — it never exists at runtime.
// ---------------------------------------------------------------------------

/** What the reviewer agent is handed: the PR to review and this round's prompt. */
const ReviewRoundIn = envelope("ReviewRoundIn", {
  prKey: "string",
  prUrl: "string",
  repo: "string",
  prNumber: "integer",
  round: "integer",
  prompt: "string",
  // Present only after a human answered an escalation and we re-review.
  answer: { type: "string", optional: true },
});

/** What the reviewer agent returns: a verdict plus a human-readable summary. */
const ReviewRoundOut = envelope("ReviewRoundOut", {
  // "converged" | "addressed" | "needs_input" | "blocked"
  status: "string",
  summary: "string",
  // Only when the agent needs a human decision.
  question: { type: "string", optional: true },
});

/** Recorded when a round is addressed but not yet converged; advances `round`. */
const PersistRoundIn = envelope("PersistRoundIn", {
  prKey: "string",
  round: "integer",
  status: { type: "string", optional: true },
  summary: { type: "string", optional: true },
});

/** The single output that keeps the loop moving: the next round number. */
const RoundAdvanced = envelope("RoundAdvanced", {
  round: "integer",
});

/** Recorded when the flow must pause for a human (needs_input / blocked / cap). */
const PersistEscalationIn = envelope("PersistEscalationIn", {
  prKey: "string",
  round: "integer",
  status: { type: "string", optional: true },
  summary: { type: "string", optional: true },
  question: { type: "string", optional: true },
});

/** Recorded once the reviewer converges; the terminal, idempotent write. */
const FinalizeIn = envelope("FinalizeIn", {
  prKey: "string",
  round: "integer",
  summary: { type: "string", optional: true },
});

/** The durable signal a poller publishes when a fresh review has landed. */
const ReviewReady = envelope("ReviewReady", {
  reviewId: "integer",
  reviewState: "string",
  submittedAt: { type: "datetime", optional: true },
});

/** The durable signal a human publishes to unblock an escalated PR. */
const EscalationAnswered = envelope("EscalationAnswered", {
  answer: "string",
  escalationId: { type: "integer", optional: true },
});

const dataEnvelopes =  {
    "review-round": { in: ReviewRoundIn, out: ReviewRoundOut },
    "persist-round": { in: PersistRoundIn, out: RoundAdvanced },
    "persist-escalation": { in: PersistEscalationIn },
    "persist-escalation-maxrounds": { in: PersistEscalationIn },
    "persist-converged": { in: FinalizeIn },
    "wait-review": { in: ReviewReady },
    "wait-answer": { in: EscalationAnswered },
  }

// ---------------------------------------------------------------------------
// The convergence loop. This is the code-first expression of urban-pr-review's
// `convergence-loop.bpmn`: a durable, multi-round loop that drives a PR to
// convergence against an automated reviewer, escalating to a human when the
// reviewer is stuck or a round cap is hit.
//
//   loop:
//     review-round (EXTERNAL agent)   ── the coding-agent harness services this
//     switch status:
//       converged  -> persist-converged; break
//       addressed  -> if round >= maxRounds:
//                        persist-escalation-maxrounds          (fall through)
//                     else:
//                        persist-round (round+1); wait-review; continue
//       default    -> persist-escalation                       (fall through)
//     wait-answer                      ── reached by both escalation paths
//
// Every `wait-*` is a real BPMN catch event — the durable wait a Temporal-style
// code-first surface cannot draw. Both resume at the loop head (`review-round`):
// `wait-review` via an explicit `continue`, `wait-answer` via the loop's natural
// repeat. The two escalation branches converge on the single trailing
// `wait-answer` (step names must be unique, so we cannot repeat the signal).
// ---------------------------------------------------------------------------
export const convergenceLoop = defineFlow(
  "convergence-loop", dataEnvelopes,
  (w) => {
    w.loop((b) => {
      // The reviewer agent. An EXTERNAL worker — a coding-agent harness —
      // services this task. The step name stays `review-round` (the BPMN element
      // id), but we override the job type to `senior:pr-review` so the same
      // hired reviewer that drives the model-first urban-pr-review app — a
      // `c8ctl nano hire`d profile with rank `senior` + capability `pr-review` —
      // services this flow too, without a `--job-type` override on `work`.
      b.task("review-round", { jobType: "senior:pr-review" });

      b.switch("status", {
        // Converged: record the terminal state and leave the loop.
        converged: (c) => {
          c.run("persist-converged", async (job) => {
            // The PR converged — record the final round and close the PR out.
            // This is the terminal, idempotent write (parity: workers/finalize).
            const { prKey, round, summary } = job.variables;
            const ts = nowTs();
            const d = db();
            await d.rounds.insert({
              pr_key: prKey, round_no: round, status: "converged", summary,
              transcript: transcriptOf(job.variables as Record<string, unknown>),
              started_at: ts, ended_at: ts,
            });
            await d.pull_requests.update(prKey, {
              status: "converged", current_round: round, outcome: summary,
              converged_at: ts, updated_at: ts,
              open_escalation_id: null, open_escalation_question: null,
            });
            console.log(`[persist-converged] ${prKey} converged at round ${round}`);
            return {};
          });
          c.break();
        },

        // Addressed but not converged: either escalate (round cap) or re-review.
        addressed: (c) =>
          c.branch("round >= maxRounds", {
            // biome-ignore lint/suspicious/noThenProperty: `then`/`else` are the FlowBuilder.branch gateway arms (a BPMN exclusive gateway), not a thenable.
            then: (g) => {
              g.run("persist-escalation-maxrounds", async (job) => {
                // Round cap hit: force a human decision. Record the capped round
                // and open a blocker escalation (parity: workers/persist-escalation
                // driven by the process's MAX_ROUNDS guard).
                const { prKey, round, summary } = job.variables;
                const question = "Round cap reached without convergence — merge as-is, or abandon?";
                const ts = nowTs();
                const transcript = transcriptOf(job.variables as Record<string, unknown>);
                const d = db();
                await d.rounds.insert({
                  pr_key: prKey, round_no: round, status: "blocked", summary,
                  transcript, started_at: ts, ended_at: ts,
                });
                const escalationId = await d.escalations.insert({
                  pr_key: prKey, round_no: round, kind: "blocker", question,
                  transcript, status: "open", asked_at: ts,
                });
                await d.pull_requests.update(prKey, {
                  status: "escalated", current_round: round, updated_at: ts,
                  open_escalation_id: Number(escalationId), open_escalation_question: question,
                });
                console.log(
                  `[persist-escalation-maxrounds] ${prKey} hit the round cap at round ${round}`,
                );
                // Falls through to the trailing `wait-answer` (human required).
                return { status: "blocked", question, escalationId: Number(escalationId) };
              });
              // Falls through to the trailing `wait-answer` (human required).
            },
            else: (g) => {
              g.run("persist-round", async (job) => {
                // An addressed round that hasn't converged: record it and park the
                // PR in `waiting_review` so the poller starts watching for the next
                // review (parity: workers/persist-round).
                const { prKey, round, status, summary } = job.variables;
                const ts = nowTs();
                const d = db();
                await d.rounds.insert({
                  pr_key: prKey, round_no: round, status, summary,
                  transcript: transcriptOf(job.variables as Record<string, unknown>),
                  started_at: ts, ended_at: ts,
                });
                await d.pull_requests.update(prKey, {
                  status: "waiting_review", current_round: round,
                  waiting_since: ts, updated_at: ts,
                });
                console.log(`[persist-round] ${prKey} addressed at round ${round}; advancing`);
                // The loop's only state mutation lives here (not in an ioMapping):
                // advance the round so the next review-round sees round+1.
                return { round: round + 1 };
              });
              // Park until the next review lands, then loop back to review-round.
              g.signal("wait-review", { correlationKey: "prKey" });
              g.continue();
            },
          }),

        // needs_input / blocked: escalate to a human.
        default: (c) => {
          c.run("persist-escalation", async (job) => {
            // needs_input / blocked: record the round that raised the escalation
            // and open an escalation row for a human to answer (parity:
            // workers/persist-escalation, agent-raised path).
            const { prKey, round, summary } = job.variables;
            // `status` drives the escalation kind (control flow), so it resolves to
            // a concrete domain value here — an unclassified escalation is a question
            // needing input. `question` is denormalised onto pull_requests below via
            // an UPDATE (which now skips `undefined`), so it must be a concrete value
            // for the answer form (ADR 0042) rather than left to a column default.
            const status = job.variables.status ?? "needs_input";
            const question = job.variables.question ?? "(no question provided)";
            const kind = status === "needs_input" ? "question" : "blocker";
            const ts = nowTs();
            const transcript = transcriptOf(job.variables as Record<string, unknown>);
            const d = db();
            await d.rounds.insert({
              pr_key: prKey, round_no: round, status, summary,
              transcript, started_at: ts, ended_at: ts,
            });
            const escalationId = await d.escalations.insert({
              pr_key: prKey, round_no: round, kind, question,
              transcript, status: "open", asked_at: ts,
            });
            await d.pull_requests.update(prKey, {
              status: "escalated", current_round: round, updated_at: ts,
              open_escalation_id: Number(escalationId), open_escalation_question: question,
            });
            console.log(
              `[persist-escalation] ${prKey} escalated (${status}) at round ${round}`,
            );
            // Falls through to the trailing `wait-answer` (human required).
            return { escalationId: Number(escalationId) };
          });
          // Falls through to the trailing `wait-answer` (human required).
        },
      });

      // Both escalation paths (round-cap + needs_input/blocked) converge here:
      // park until a human answers, then loop back to review-round.
      b.signal("wait-answer", { correlationKey: "prKey" });
    });
  },
);

export default convergenceLoop;
