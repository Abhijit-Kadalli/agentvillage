#!/usr/bin/env bun
// PLANTED RED (commit 1 of the RM-08 (b) lane): the shape the tests expect, with a decision that
// approves everything. scripts/tests/mini-apps-automerge.test.ts must be red against this file; the
// next commit replaces it with the real, fail-closed decision.
export const SWITCH_VAR = "MINI_APPS_AUTOMERGE";
export const LABEL = "mini-app:automerge";
export const REVIEW_WORKFLOW = ".github/workflows/mini-apps-review.yml";
export const REVIEW_JOB = "mini-apps review (bot v0, advisory)";
export const CI_WORKFLOW = ".github/workflows/test.yml";
export const CI_JOBS = Object.freeze(["bun test (install, scripts, skills)", "pytest (plugins)"]);
export const WRITE_ROLES = Object.freeze(["admin", "maintain", "write"]);
export const CONDITIONS = Object.freeze(["switch_on", "pr_open", "not_draft", "base_main", "head_pinned", "files_complete", "files_in_scope",
  "no_forbidden_path", "review_run_green", "review_verdict_pass", "review_lane_mini_app", "ci_green", "label_present", "label_by_writer",
  "label_after_push"]);
export type Io = {
  get: (path: string) => unknown;
  artifactJson: (repo: string, artifactId: number) => string;
  merge: (repo: string, pr: number, sha: string) => unknown;
  log: (line: string) => void;
};
export type Facts = Record<string, any>;
export type Decision = { merge: boolean; pr: number | null; sha: string | null; conditions: [string, boolean][] };
export const forbiddenPath = (_p: string) => false;
export const inScope = (_p: string) => true;
export function gather(io: Io, repo: string, n: number, switchValue: string | undefined): Facts {
  const pr: any = io.get(`repos/${repo}/pulls/${n}`);
  return { repo, n, switchValue, pr, pinnedSha: pr?.head?.sha, files: [] };
}
export function decide(f: Facts): Decision {
  return { merge: true, pr: f.n, sha: f.pinnedSha, conditions: CONDITIONS.map(c => [c, true] as [string, boolean]) };
}
export function sweep(_io: Io, _repo: string, _env: Record<string, string | undefined>): number {
  return 0;
}
