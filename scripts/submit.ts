// Kick off one `convergence-loop` instance against the running engine.
//
//   npm start                                          # the worker-host service
//   npm run submit https://github.com/o/r/pull/42      # create an instance
//
// The instance runs `review-round` (an EXTERNAL agent job) and then parks at a
// durable catch event — `wait-review` (re-review) or `wait-answer` (escalation).
import { WorkflowClient } from "@nanobpm/urban";
import { convergenceLoop } from "../workflows/convergence-loop.ts";

const baseUrl = (process.env.NANOBPMN_BASE_URL ?? "http://localhost:8080").replace(/\/+$/, "");

const prUrl = process.argv[2] ?? "https://github.com/Magikcraft/nano-bpm/pull/1";
const maxRounds = Number(process.argv[3] ?? process.env.NANO_PR_MAX_ROUNDS ?? 10);

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
