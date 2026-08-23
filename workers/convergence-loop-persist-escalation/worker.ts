// Handler stub for the `convergence-loop:persist-escalation` service task, scaffolded from the model (ADR 0056).
// This file is yours to edit — `urban gen` will never overwrite it. Implement the body
// below (use `app.data.table(...)` for state), replacing the guard warn + throw so the
// "worker not implemented" warning does not survive into a working handler.
import type { AppJobHandler } from "@nanobpm/urban/worker";

const handler: AppJobHandler = async (job, app) => {
	// `job.variables` is an open Record<string, unknown> (no declared input type).
	// Reach app state and services through the injected `app` API.
	// Structured logs: `app.log.info("done", { … })` — auto-tagged with this job's
	// { jobKey, jobType, processInstanceKey, elementId } (ADR 0061).
	app.log.warn("worker not implemented", { jobKey: job.jobKey });
	throw new Error("worker not implemented: convergence-loop:persist-escalation");
};

export default handler;
