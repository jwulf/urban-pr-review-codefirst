// Row shapes for the app's sqlite datasource (`db/migrations/*.sql`). These used
// to be generated into `nano-generated/domain-rows.d.ts`; with the app now on the
// published `@nanobpm/urban` data layer (`DataLayer.table<T>(name, pk)`), we keep
// the handful of types the app actually persists here as plain source.

export interface Escalations {
  id: number;
  pr_key: string;
  round_no: number;
  kind: string;
  question: string;
  answer: string | null;
  status: string;
  asked_at: string;
  answered_at: string | null;
  transcript: string | null;
}

export interface PullRequests {
  pr_key: string;
  repo: string;
  number: number;
  url: string;
  title: string | null;
  status: string;
  current_round: number;
  process_key: string | null;
  waiting_since: string | null;
  last_review_id: number | null;
  outcome: string | null;
  created_at: string;
  updated_at: string;
  converged_at: string | null;
  open_escalation_id: number | null;
  open_escalation_question: string | null;
}

export interface Rounds {
  id: number;
  pr_key: string;
  round_no: number;
  status: string | null;
  summary: string | null;
  started_at: string;
  ended_at: string | null;
  transcript: string | null;
}
