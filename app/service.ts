// urban-pr-review-codefirst — the app's business logic over the Urban runtime
// seams. Shared by the action handlers (`actions/*`) and the review-ready poller.
//
// Data access goes through the injected `@nanobpm/urban` `DataLayer`
// (`data.table<T>(name, pk)`); engine calls go through the code-first
// `WorkflowClient` in `app/engine.ts`, which derives the process id and the
// `wait-*` message names from `convergence-loop`.
import type { DataLayer, EngineClient } from "@nanobpm/urban";
import { convergenceLoop, MAX_ROUNDS, workflow } from "./engine.ts";
import type { Escalations, PullRequests, Rounds } from "./rows.ts";
import { fetchPrReviews } from "./github.ts";

export interface ParsedPr {
  repo: string;
  number: number;
  url: string;
  prKey: string;
}

const now = (): string => new Date().toISOString();

/** A PR is "done" in exactly these two states; everything else (converging, waiting_review,
 *  escalated) is in flight. The status endpoint and the cancel guard both key off this. */
export const TERMINAL_STATUSES: readonly string[] = ["converged", "abandoned"];

const prs = (data: DataLayer) => data.table<PullRequests>("pull_requests", "pr_key");
const rounds = (data: DataLayer) => data.table<Rounds>("rounds", "id");
const escalations = (data: DataLayer) => data.table<Escalations>("escalations", "id");

/** Parse "owner/repo#123" or a canonical PR URL into its parts. */
export function parsePr(input: string): ParsedPr | null {
  const s = input.trim();
  let m = s.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  if (m) {
    const repo = `${m[1]}/${m[2]}`;
    const number = Number(m[3]);
    return { repo, number, url: `https://github.com/${repo}/pull/${number}`, prKey: `${repo}#${number}` };
  }
  m = s.match(/^([^/]+\/[^#]+)#(\d+)$/);
  if (m) {
    const repo = m[1];
    const number = Number(m[2]);
    return { repo, number, url: `https://github.com/${repo}/pull/${number}`, prKey: `${repo}#${number}` };
  }
  return null;
}

// The review prompt is read once (host-agnostic: Deno.readTextFile under a
// compiled binary, node:fs under Node) and carried on the instance, so a PR keeps
// the instructions it started with for its whole run.
let _prompt: string | null = null;
async function reviewPrompt(): Promise<string> {
  if (_prompt !== null) return _prompt;
  const path = "prompts/review-round.md";
  try {
    const g = globalThis as { Deno?: { readTextFile(p: string): Promise<string> } };
    _prompt = g.Deno?.readTextFile
      ? await g.Deno.readTextFile(path)
      : await (await import("node:fs/promises")).readFile(path, "utf8");
  } catch {
    _prompt = "";
  }
  return _prompt;
}

/** Register a PR row (if new) and start the convergence process. Idempotent on prKey. */
export async function submitPr(data: DataLayer, parsed: ParsedPr) {
  const { repo, number, url, prKey } = parsed;
  const table = prs(data);
  const existing = await table.get(prKey);
  if (existing && !TERMINAL_STATUSES.includes(existing.status)) {
    return { prKey, alreadyRunning: true };
  }
  const ts = now();
  if (existing) {
    // Re-open a previously converged/abandoned PR for a fresh convergence run.
    await table.update(prKey, {
      status: "converging", current_round: 1, url,
      waiting_since: null, last_review_id: null, outcome: null, converged_at: null,
      updated_at: ts,
    });
  } else {
    await table.insert({
      pr_key: prKey, repo, number, url, status: "converging", current_round: 1,
      created_at: ts, updated_at: ts,
    });
  }
  const { processInstanceKey } = await workflow().start(convergenceLoop, {
    repo, prNumber: number, prUrl: url, prKey, round: 1, maxRounds: MAX_ROUNDS,
    prompt: await reviewPrompt(),
  });
  if (processInstanceKey != null) {
    await table.update(prKey, { process_key: String(processInstanceKey) });
  }
  return { prKey, processKey: processInstanceKey };
}

/** Answer an open escalation → record it and resume the process at `wait-answer`. */
export async function answerEscalation(data: DataLayer, prKey: string, answer: string) {
  const open = (await escalations(data).find({ pr_key: prKey, status: "open" }))
    .sort((a, b) => b.id - a.id)[0];
  if (!open) return { ok: false, reason: "no open escalation" };
  const escalationId = open.id;
  const ts = now();
  await escalations(data).update(escalationId, { answer, status: "answered", answered_at: ts });
  await prs(data).update(prKey, {
    status: "converging", updated_at: ts,
    open_escalation_id: null, open_escalation_question: null,
  });
  // Correlate the `wait-answer` signal (derived message `convergence-loop:wait-answer`)
  // to the parked instance by its `prKey`.
  await workflow().signal(convergenceLoop, "wait-answer", prKey, { answer, escalationId });
  return { ok: true, escalationId };
}

/** How a caller identifies the run to cancel: by its engine `processInstanceKey` or, more
 * ergonomically, by the `prKey` the status endpoint reports. The cancel action rejects a
 * request that supplies both, so exactly one selector reaches here. */
export interface CancelSelector {
  processInstanceKey?: string;
  prKey?: string;
}

/** Cancel a PR's running convergence instance and mark it abandoned. Terminating the engine
 *  instance emits no completion event (no worker runs), so the app-tier flips the PR's status
 *  here. Accepts either selector; a PR already in a terminal state is left untouched so a stale
 *  cancel can't overwrite a `converged` outcome with `abandoned`. */
export async function cancelRun(data: DataLayer, engine: EngineClient, selector: CancelSelector) {
  const { processInstanceKey, prKey } = selector;
  const table = prs(data);
  const pr = prKey
    ? await table.get(prKey)
    : processInstanceKey
    ? (await table.find({ process_key: processInstanceKey }))[0]
    : undefined;
  if (pr && TERMINAL_STATUSES.includes(pr.status)) {
    return { ok: false, kind: "terminal", reason: `PR already ${pr.status}`, prKey: pr.pr_key };
  }
  const instanceKey = pr?.process_key ?? processInstanceKey ?? null;
  if (instanceKey) {
    try {
      await engine.cancelInstance({ processInstanceKey: instanceKey });
    } catch (err) {
      // The instance may already be gone (converged/cancelled) — still reconcile the app row so
      // a stale "converging" PR can't linger in the UI.
      console.warn(`[cancel] engine cancel for ${instanceKey}: ${err}`);
    }
  }
  if (pr) {
    await table.update(String(pr.pr_key), {
      status: "abandoned", updated_at: now(),
      open_escalation_id: null, open_escalation_question: null,
    });
    return { ok: true, prKey: pr.pr_key };
  }
  return { ok: false, kind: "not_found", reason: "no PR for that selector" };
}

/** A PR currently in flight, as reported by the status endpoint. */
export interface ActivePr {
  prKey: string;
  repo: string;
  number: number;
  url: string;
  title: string | null;
  status: string;
  round: number;
  processKey: string | null;
  waitingSince: string | null;
  openEscalation: string | null;
  updatedAt: string;
}

/** Every tracked PR not in a terminal state (converged/abandoned), newest-updated first. Backs
 *  the GET status endpoint so an operator or an external harness can see what is in flight
 *  without reading the datasource directly. */
export async function activePrs(data: DataLayer): Promise<ActivePr[]> {
  const all = await prs(data).all();
  return all
    .filter((p) => !TERMINAL_STATUSES.includes(p.status))
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
    .map((p) => ({
      prKey: p.pr_key,
      repo: p.repo,
      number: p.number,
      url: p.url,
      title: p.title ?? null,
      status: p.status,
      round: p.current_round,
      processKey: p.process_key ?? null,
      waitingSince: p.waiting_since ?? null,
      openEscalation: p.open_escalation_question ?? null,
      updatedAt: p.updated_at,
    }));
}

/** One poll pass: for each PR waiting on review, fetch fresh GitHub reviews (via the host
 *  `gh` CLI or a token — see `app/github.ts`) and, when one has landed, resume the instance
 *  parked at `wait-review`. */
export async function pollOnce(data: DataLayer) {
  const token = process.env.GITHUB_TOKEN ?? "";
  const waiting = await prs(data).find({ status: "waiting_review" });
  for (const pr of waiting) {
    const { repo, number, pr_key: prKey } = pr;
    const lastId = pr.last_review_id ?? 0;
    try {
      const reviews = await fetchPrReviews(repo, number, token);
      if (reviews === null) return; // no usable transport (no gh, no token) → idle
      const fresh = reviews
        .filter((rv) => rv.id > lastId && rv.submitted_at && (!pr.waiting_since || rv.submitted_at >= pr.waiting_since))
        .sort((a, b) => a.id - b.id)
        .pop();
      if (!fresh) continue;
      await prs(data).update(prKey, {
        last_review_id: fresh.id, status: "converging", updated_at: now(),
      });
      // Resume the instance parked at `wait-review` (derived message
      // `convergence-loop:wait-review`), then it loops back to review-round.
      await workflow().signal(convergenceLoop, "wait-review", prKey, {
        reviewId: fresh.id, reviewState: fresh.state, submittedAt: fresh.submitted_at ?? null,
      });
      console.log(`[poller] review ${fresh.id} (${fresh.state}) → ${prKey}`);
    } catch (err) {
      console.error(`[poller] ${prKey}: ${err}`);
    }
  }
}
