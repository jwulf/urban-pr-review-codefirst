// Answer an escalation, resuming a PR parked at `wait-answer` (needs_input,
// blocked, or round-cap). This is the human-in-the-loop half of the flow — a
// real, engine-visible catch event a Temporal-style code-first surface cannot draw.
//
//   npm run answer -- owner/repo#42 "merge as-is"
import { WorkflowClient } from "@nanobpm/urban";
import { convergenceLoop } from "../workflows/convergence-loop.ts";

const baseUrl = (process.env.NANOBPMN_BASE_URL ?? "http://localhost:8080").replace(/\/+$/, "");
const prKey = process.argv[2] ?? "owner/repo#1";
const answer = process.argv[3] ?? "proceed";

const client = new WorkflowClient({ baseUrl });
// `correlationKey` is the instance's `prKey`; the message name is derived as
// `convergence-loop:wait-answer`.
await client.signal(convergenceLoop, "wait-answer", prKey, {
  answer,
  escalationId: Number(process.argv[4] ?? 0),
});
console.log(`answered ${convergenceLoop.id} (prKey=${prKey}, answer=${JSON.stringify(answer)})`);
