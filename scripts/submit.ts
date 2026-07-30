// Kick off one `convergence-loop` instance against the running app/gateway.
//
//   deno task start                              # the worker-host service
//   deno task submit https://github.com/o/r/pull/42   # create an instance
//
// The instance runs `review-round` (an EXTERNAL agent job) and then parks at a
// durable catch event — `wait-review` (re-review) or `wait-answer` (escalation).
import { WorkflowClient } from "@nanobpm/workflow";
import { convergenceLoop } from "../workflows/convergence-loop.ts";

const baseUrl = (Deno.env.get("NANOBPMN_BASE_URL") ?? "http://localhost:8080").replace(/\/+$/, "");

const prUrl = Deno.args[0] ?? "https://github.com/Magikcraft/nano-bpm/pull/1";
const maxRounds = Number(Deno.args[1] ?? Deno.env.get("MAX_ROUNDS") ?? 5);

// Parse "https://github.com/<owner>/<repo>/pull/<n>" into the fields the flow needs.
const m = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
if (!m) throw new Error(`could not parse a GitHub PR URL from "${prUrl}"`);
const [, owner, repo, prNumber] = m;
const prKey = `${owner}/${repo}#${prNumber}`;

const client = new WorkflowClient({ baseUrl });
const { processInstanceKey } = await client.start(convergenceLoop, {
  prKey,
  prUrl,
  repo: `${owner}/${repo}`,
  prNumber: Number(prNumber),
  round: 1,
  maxRounds,
  prompt: "Review this PR. Reply converged | addressed | needs_input | blocked with a summary.",
});
console.log(`started ${convergenceLoop.id} instance ${processInstanceKey} (prKey=${prKey}, maxRounds=${maxRounds})`);
