// Answer an escalation, resuming a PR parked at `wait-answer` (needs_input,
// blocked, or round-cap). This is the human-in-the-loop half of the flow — a
// real, engine-visible catch event a Temporal-style code-first surface cannot draw.
//
//   deno task answer owner/repo#42 "merge as-is"
import { WorkflowClient } from "@nanobpm/workflow";
import { convergenceLoop } from "../workflows/convergence-loop.ts";

const baseUrl = (Deno.env.get("NANOBPMN_BASE_URL") ?? "http://localhost:8080").replace(/\/+$/, "");
const prKey = Deno.args[0] ?? "Magikcraft/nano-bpm#1";
const answer = Deno.args[1] ?? "proceed";

const client = new WorkflowClient({ baseUrl });
// `correlationKey` is the instance's `prKey`; the message name is derived as
// `convergence-loop:wait-answer`.
await client.signal(convergenceLoop, "wait-answer", prKey, {
  answer,
  escalationId: Number(Deno.args[2] ?? 0),
});
console.log(`answered ${convergenceLoop.id} (prKey=${prKey}, answer=${JSON.stringify(answer)})`);
