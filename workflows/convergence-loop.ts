import { defineFlow, envelope } from "@nanobpm/workflow";

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
  "convergence-loop",
  {
    "review-round": { in: ReviewRoundIn, out: ReviewRoundOut },
    "persist-round": { in: PersistRoundIn, out: RoundAdvanced },
    "persist-escalation": { in: PersistEscalationIn },
    "persist-escalation-maxrounds": { in: PersistEscalationIn },
    "persist-converged": { in: FinalizeIn },
    "wait-review": { in: ReviewReady },
    "wait-answer": { in: EscalationAnswered },
  },
  (w) => {
    w.loop((b) => {
      // The reviewer agent. An EXTERNAL worker — a coding-agent harness — services
      // the job type `convergence-loop:review-round`. The app never names it; it
      // only owns the durable orchestration around it.
      b.task("review-round");

      b.switch("status", {
        // Converged: record the terminal state and leave the loop.
        converged: (c) => {
          c.run("persist-converged", async (job) => {
            console.log(`[persist-converged] ${job.variables.prKey} converged at round ${job.variables.round}`);
            return {};
          });
          c.break();
        },

        // Addressed but not converged: either escalate (round cap) or re-review.
        addressed: (c) =>
          c.branch("round >= maxRounds", {
            then: (g) => {
              g.run("persist-escalation-maxrounds", async (job) => {
                console.log(
                  `[persist-escalation-maxrounds] ${job.variables.prKey} hit the round cap at round ${job.variables.round}`,
                );
                // Force a human decision: mark blocked and ask to proceed or stop.
                return {
                  status: "blocked",
                  question: "Round cap reached without convergence — merge as-is, or abandon?",
                };
              });
              // Falls through to the trailing `wait-answer` (human required).
            },
            else: (g) => {
              g.run("persist-round", async (job) => {
                const round = typeof job.variables.round === "number" ? job.variables.round : 0;
                console.log(`[persist-round] ${job.variables.prKey} addressed at round ${round}; advancing`);
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
            console.log(
              `[persist-escalation] ${job.variables.prKey} escalated (${job.variables.status}) at round ${job.variables.round}`,
            );
            return {};
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
