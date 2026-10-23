// The mini-app merge Action (RM-08 (b)): scripts/mini-apps-automerge.ts and
// .github/workflows/mini-apps-automerge.yml. The decision is fed recorded REST shapes
// (fixtures/mini-apps-automerge/pass.json, a map of GET path -> response); every test breaks ONE
// thing and expects no merge, and only the untouched fixture merges, with its head sha.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import * as A from "../mini-apps-automerge";
import { GATE_FILES } from "../mini-apps-review";

const REPO = "Edge-City/agentvillage";
const H = "3f1c2b7a9d4e5f60718293a4b5c6d7e8f9012345";
const OLD = "1d2e3f405162738495a6b7c8d9e0f1a2b3c4d5e6";
const FIX: Record<string, any> = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "mini-apps-automerge", "pass.json"), "utf8"));
const P = (rest: string) => `repos/${REPO}/${rest}`;
const PR = P("pulls/901");
const FILES = P("pulls/901/files?per_page=100&page=1");
const TIMELINE = P("issues/901/timeline?per_page=100&page=1");
const PERM = P("collaborators/village-maintainer/permission");
const RWF = P("actions/workflows/mini-apps-review.yml");
const RRUNS = P(`actions/workflows/389688889/runs?head_sha=${H}&event=pull_request&per_page=100`);
const RJOBS = P("actions/runs/39983043256/jobs?filter=latest&per_page=100");
const RARTS = P("actions/runs/39983043256/artifacts?per_page=100");
const CWF = P("actions/workflows/test.yml");
const CRUNS = P(`actions/workflows/389000001/runs?head_sha=${H}&event=pull_request&per_page=100`);
const CJOBS = P("actions/runs/39983043342/jobs?filter=latest&per_page=100");

type Fix = Record<string, any>;
const fixture = (mut?: (f: Fix) => void): Fix => {
  const f = structuredClone(FIX);
  mut?.(f);
  return f;
};
const report = (f: Fix) => f._artifact_json["12514640863"];
const labeled = (f: Fix) => f[TIMELINE].find((e: any) => e.event === "labeled");

type Calls = { get: string[]; artifact: number[]; merge: [string, number, string][]; log: string[] };
function fakeIo(f: Fix | ((n: number) => Fix), calls: Calls, mergeAnswer: () => unknown = () => ({ merged: true, sha: "9".repeat(40) })): A.Io {
  let round = 0;
  const now = () => (typeof f === "function" ? f(round) : f);
  return {
    get: (path) => {
      calls.get.push(path);
      if (path === PR) round += 1;
      const fx = now();
      if (!(path in fx)) throw new Error(`HTTP 404 ${path}`);
      return structuredClone(fx[path]);
    },
    artifactJson: (_repo, id) => {
      calls.artifact.push(id);
      const body = now()._artifact_json?.[String(id)];
      if (body === undefined) throw new Error("HTTP 404 artifact");
      return typeof body === "string" ? body : JSON.stringify(body);
    },
    merge: (repo, n, sha) => {
      calls.merge.push([repo, n, sha]);
      return mergeAnswer();
    },
    log: (line) => calls.log.push(line),
  };
}
const newCalls = (): Calls => ({ get: [], artifact: [], merge: [], log: [] });
function decideFor(f: Fix, switchValue: string | undefined = "1"): A.Decision {
  return A.decide(A.gather(fakeIo(f, newCalls()), REPO, 901, switchValue));
}
const cond = (d: A.Decision, name: string) => {
  const hit = d.conditions.find(([n]) => n === name);
  if (!hit) throw new Error(`no condition ${name}`);
  return hit[1];
};
/** Exactly one condition is false (the one named) and there is no merge. */
function onlyFalse(d: A.Decision, ...names: string[]) {
  expect(d.merge).toBe(false);
  const off = d.conditions.filter(([, v]) => !v).map(([n]) => n).sort();
  expect(off).toEqual([...names].sort());
}

describe("the closed lists", () => {
  test("names: the label, the switch, the bot check and the CI checks", () => {
    expect(A.LABEL).toBe("mini-app:automerge");
    expect(A.SWITCH_VAR).toBe("MINI_APPS_AUTOMERGE");
    expect(A.REVIEW_WORKFLOW).toBe(".github/workflows/mini-apps-review.yml");
    expect(A.REVIEW_JOB).toBe("mini-apps review (bot v0, advisory)");
    expect(A.CI_WORKFLOW).toBe(".github/workflows/test.yml");
    expect([...A.CI_JOBS]).toEqual(["bun test (install, scripts, skills)", "pytest (plugins)"]);
    expect([...A.WRITE_ROLES].sort()).toEqual(["admin", "maintain", "write"]);
  });
  test("the CI job names are the job names test.yml really has", () => {
    const wf = parse(readFileSync(join(import.meta.dir, "..", "..", ".github", "workflows", "test.yml"), "utf8"));
    const names = Object.values(wf.jobs).map((j: any) => j.name);
    for (const n of A.CI_JOBS) expect(names).toContain(n);
  });
  test("the bot job name is the one mini-apps-review.yml really has", () => {
    const wf = parse(readFileSync(join(import.meta.dir, "..", "..", ".github", "workflows", "mini-apps-review.yml"), "utf8"));
    expect(wf.name).toBe("mini-apps review");
    expect(Object.values(wf.jobs).map((j: any) => j.name)).toEqual([A.REVIEW_JOB]);
  });
  test("every one of the bot's GATE_FILES, this script and its test are forbidden paths", () => {
    for (const g of GATE_FILES) expect(A.forbiddenPath(g)).toBe(true);
    expect(A.forbiddenPath("scripts/mini-apps-automerge.ts")).toBe(true);
    expect(A.forbiddenPath("scripts/tests/mini-apps-automerge.test.ts")).toBe(true);
    expect(A.forbiddenPath(".github/workflows/anything.yml")).toBe(true);
    expect(A.forbiddenPath("skills/edge-india/references/a.md")).toBe(true);
    expect(A.forbiddenPath("mini-apps/hello-board/manifest.json")).toBe(false);
  });
  test("the scope: one directory down in mini-apps/ or skills/, nothing else, no dot segments", () => {
    expect(A.inScope("mini-apps/hello-board/manifest.json")).toBe(true);
    expect(A.inScope("skills/hello-board/SKILL.md")).toBe(true);
    for (const p of ["mini-apps/catalog.json", "install/paths.ts", "skills/x/../../install/paths.ts", "skills//x/SKILL.md", "/mini-apps/x/a", "mini-apps/X/a", "mini-apps/x/./a", "README.md", "", "mini-apps/x/"]) {
      expect(A.inScope(p)).toBe(false);
    }
  });
});

describe("decide: the untouched fixture merges", () => {
  test("all conditions true => merge, at the pinned head sha", () => {
    const d = decideFor(fixture());
    expect(d.conditions.map(([n]) => n)).toEqual([...A.CONDITIONS]);
    expect(d.conditions.every(([, v]) => v)).toBe(true);
    expect(d.merge).toBe(true);
    expect(d.sha).toBe(H);
    expect(d.pr).toBe(901);
  });
  test("a same-repository pull request whose runs list it merges too", () => {
    const d = decideFor(fixture((f) => {
      f[PR].head.repo.full_name = REPO;
      for (const k of [RRUNS, CRUNS]) {
        f[k].workflow_runs[0].head_repository.full_name = REPO;
        f[k].workflow_runs[0].pull_requests = [{ number: 901 }];
      }
    }));
    expect(d.merge).toBe(true);
  });
  test("maintain and admin labelers count", () => {
    for (const role of ["maintain", "admin"]) {
      expect(decideFor(fixture((f) => { f[PERM].role_name = role; f[PERM].permission = role === "admin" ? "admin" : "write"; })).merge).toBe(true);
    }
  });
});

describe("decide: each single condition false => no merge", () => {
  test("kill switch unset, empty, 0, true, ' 1' => switch_on false", () => {
    for (const v of [undefined, "", "0", "true", " 1", "1 ", "yes"]) onlyFalse(decideFor(fixture(), v), "switch_on");
  });
  test("closed, or already merged", () => {
    onlyFalse(decideFor(fixture((f) => { f[PR].state = "closed"; })), "pr_open");
    onlyFalse(decideFor(fixture((f) => { f[PR].merged = true; })), "pr_open");
  });
  test("draft (and a draft field that is missing)", () => {
    onlyFalse(decideFor(fixture((f) => { f[PR].draft = true; })), "not_draft");
    onlyFalse(decideFor(fixture((f) => { delete f[PR].draft; })), "not_draft");
  });
  test("base is not main, or main of another repository", () => {
    onlyFalse(decideFor(fixture((f) => { f[PR].base.ref = "release"; })), "base_main");
    onlyFalse(decideFor(fixture((f) => { f[PR].base.repo.full_name = "someone-outside/agentvillage"; })), "base_main");
  });
  test("a stale sha: the pull request's head moved after the facts were pinned", () => {
    const facts = A.gather(fakeIo(fixture(), newCalls()), REPO, 901, "1");
    facts.pr.head.sha = OLD;
    const d = A.decide(facts);
    expect(d.merge).toBe(false);
    expect(cond(d, "head_pinned")).toBe(false);
  });
  test("a core path (install/)", () => {
    onlyFalse(decideFor(fixture((f) => { f[FILES][1].filename = "install/paths.ts"; })), "files_in_scope", "no_forbidden_path");
    onlyFalse(decideFor(fixture((f) => { f[FILES][1].filename = "plugins/av-vote/vote.py"; })), "files_in_scope");
  });
  test("a references/** path", () => {
    onlyFalse(decideFor(fixture((f) => { f[FILES][1].filename = "skills/edge-india/references/menu.md"; })), "no_forbidden_path");
  });
  test("a .github path (a workflow the pull request adds to spoof a check name)", () => {
    onlyFalse(decideFor(fixture((f) => { f[FILES][1].filename = ".github/workflows/mini-apps-review-2.yml"; })), "files_in_scope", "no_forbidden_path");
  });
  test("the bot itself, or another of its GATE_FILES", () => {
    onlyFalse(decideFor(fixture((f) => { f[FILES][1].filename = "scripts/mini-apps-review.ts"; })), "files_in_scope", "no_forbidden_path");
    onlyFalse(decideFor(fixture((f) => { f[FILES][1].filename = "mini-apps/catalog.json"; })), "files_in_scope", "no_forbidden_path");
  });
  test("a rename whose OLD path is out of scope", () => {
    onlyFalse(decideFor(fixture((f) => { f[FILES][1].status = "renamed"; f[FILES][1].previous_filename = "install/paths.ts"; })), "files_in_scope", "no_forbidden_path");
  });
  test("an incomplete file list: count differs from changed_files, empty, or at the API's 3000 cap", () => {
    onlyFalse(decideFor(fixture((f) => { f[PR].changed_files = 3; })), "files_complete", "files_in_scope", "no_forbidden_path");
    onlyFalse(decideFor(fixture((f) => { f[PR].changed_files = 0; f[FILES] = []; })), "files_complete", "files_in_scope", "no_forbidden_path");
    const d = A.decide({ ...A.gather(fakeIo(fixture(), newCalls()), REPO, 901, "1"), files: Array.from({ length: 3000 }, (_, i) => ({ filename: `mini-apps/a${i}/README.md` })) });
    expect(cond(d, "files_complete")).toBe(false);
    expect(d.merge).toBe(false);
  });
  test("the file list cannot be read", () => {
    onlyFalse(decideFor(fixture((f) => { delete f[FILES]; })), "files_complete", "files_in_scope", "no_forbidden_path");
  });
  test("NEEDS_HUMAN, FAIL", () => {
    onlyFalse(decideFor(fixture((f) => { report(f).verdict = "NEEDS_HUMAN"; })), "review_verdict_pass");
    onlyFalse(decideFor(fixture((f) => { report(f).verdict = "FAIL"; })), "review_verdict_pass");
  });
  test("lane core, even with a PASS", () => {
    onlyFalse(decideFor(fixture((f) => { report(f).lane = "core"; })), "review_lane_mini_app");
  });
  test("gate_changed, core_path, first_party_package (ov#475), baseline_skill, bot_error findings, even with a PASS", () => {
    for (const code of ["gate_changed", "core_path", "first_party_package", "baseline_skill", "bot_error"]) {
      onlyFalse(decideFor(fixture((f) => { report(f).findings.push({ code, severity: "S", text: "x" }); })), "review_lane_mini_app");
    }
  });
  test("the report judged another sha, came from another bot, or is not JSON", () => {
    onlyFalse(decideFor(fixture((f) => { report(f).head = OLD; })), "review_verdict_pass");
    onlyFalse(decideFor(fixture((f) => { report(f).bot = "something-else"; })), "review_verdict_pass");
    onlyFalse(decideFor(fixture((f) => { f._artifact_json["12514640863"] = "{not json"; })), "review_verdict_pass", "review_lane_mini_app");
  });
  test("the artifact is missing, expired, or belongs to another run or sha", () => {
    onlyFalse(decideFor(fixture((f) => { f[RARTS].artifacts = []; })), "review_verdict_pass", "review_lane_mini_app");
    onlyFalse(decideFor(fixture((f) => { f[RARTS].artifacts[0].expired = true; })), "review_verdict_pass", "review_lane_mini_app");
    onlyFalse(decideFor(fixture((f) => { f[RARTS].artifacts[0].workflow_run.id = 1; })), "review_verdict_pass", "review_lane_mini_app");
    onlyFalse(decideFor(fixture((f) => { f[RARTS].artifacts[0].workflow_run.head_sha = OLD; })), "review_verdict_pass", "review_lane_mini_app");
    onlyFalse(decideFor(fixture((f) => { f[RARTS].artifacts[0].name = "mini-apps-review-x"; })), "review_verdict_pass", "review_lane_mini_app");
    onlyFalse(decideFor(fixture((f) => { f[RARTS].artifacts[0].size_in_bytes = 50 * 1024 * 1024; })), "review_verdict_pass", "review_lane_mini_app");
  });
  test("the bot run failed, is still running, or its newest run failed after an older success", () => {
    onlyFalse(decideFor(fixture((f) => { f[RRUNS].workflow_runs[0].conclusion = "failure"; })), "review_run_green");
    onlyFalse(decideFor(fixture((f) => { f[RRUNS].workflow_runs[0].status = "in_progress"; f[RRUNS].workflow_runs[0].conclusion = null; })), "review_run_green");
    onlyFalse(decideFor(fixture((f) => {
      const newer = { ...structuredClone(f[RRUNS].workflow_runs[0]), id: 39983099999, run_number: 20, conclusion: "failure" };
      f[RRUNS].workflow_runs.unshift(newer);
      f[P("actions/runs/39983099999/jobs?filter=latest&per_page=100")] = { total_count: 0, jobs: [] };
      f[P("actions/runs/39983099999/artifacts?per_page=100")] = { total_count: 0, artifacts: [] };
    })), "review_run_green", "review_verdict_pass", "review_lane_mini_app");
  });
  test("check-name spoofing: a run named 'mini-apps review' from another workflow file, or another head repository, does not count", () => {
    onlyFalse(decideFor(fixture((f) => { f[RRUNS].workflow_runs[0].path = ".github/workflows/evil.yml"; })), "review_run_green", "review_verdict_pass", "review_lane_mini_app");
    onlyFalse(decideFor(fixture((f) => { f[RRUNS].workflow_runs[0].workflow_id = 1; })), "review_run_green", "review_verdict_pass", "review_lane_mini_app");
    onlyFalse(decideFor(fixture((f) => { f[RRUNS].workflow_runs[0].head_repository.full_name = "attacker/agentvillage"; })), "review_run_green", "review_verdict_pass", "review_lane_mini_app");
    onlyFalse(decideFor(fixture((f) => { f[RRUNS].workflow_runs[0].pull_requests = [{ number: 902 }]; })), "review_run_green", "review_verdict_pass", "review_lane_mini_app");
    onlyFalse(decideFor(fixture((f) => { f[RWF].path = ".github/workflows/evil.yml"; })), "review_run_green", "review_verdict_pass", "review_lane_mini_app");
  });
  test("the bot job is missing, misnamed, failed, or ran another sha", () => {
    onlyFalse(decideFor(fixture((f) => { f[RJOBS].jobs = []; })), "review_run_green");
    onlyFalse(decideFor(fixture((f) => { f[RJOBS].jobs[0].name = "mini-apps review"; })), "review_run_green");
    onlyFalse(decideFor(fixture((f) => { f[RJOBS].jobs[0].conclusion = "skipped"; })), "review_run_green");
    onlyFalse(decideFor(fixture((f) => { f[RJOBS].jobs[0].head_sha = OLD; })), "review_run_green");
  });
  test("re-run of an old successful check: a run for an older sha does not count for the new head", () => {
    onlyFalse(decideFor(fixture((f) => { f[RRUNS].workflow_runs[0].head_sha = OLD; f[RRUNS].workflow_runs[0].run_attempt = 2; })), "review_run_green", "review_verdict_pass", "review_lane_mini_app");
    onlyFalse(decideFor(fixture((f) => { f[CRUNS].workflow_runs[0].head_sha = OLD; f[CRUNS].workflow_runs[0].run_attempt = 2; })), "ci_green");
  });
  test("a missing CI check => no merge", () => {
    onlyFalse(decideFor(fixture((f) => { f[CJOBS].jobs = f[CJOBS].jobs.filter((j: any) => j.name !== "pytest (plugins)"); })), "ci_green");
    onlyFalse(decideFor(fixture((f) => { f[CRUNS].workflow_runs = []; })), "ci_green");
    onlyFalse(decideFor(fixture((f) => { delete f[CWF]; })), "ci_green");
  });
  test("a CI check that failed, was skipped, ran another sha, or is listed twice", () => {
    onlyFalse(decideFor(fixture((f) => { f[CJOBS].jobs[0].conclusion = "failure"; })), "ci_green");
    onlyFalse(decideFor(fixture((f) => { f[CJOBS].jobs[1].conclusion = "skipped"; })), "ci_green");
    onlyFalse(decideFor(fixture((f) => { f[CJOBS].jobs[1].head_sha = OLD; })), "ci_green");
    onlyFalse(decideFor(fixture((f) => { f[CJOBS].jobs.push({ ...f[CJOBS].jobs[1], id: 3, conclusion: "failure" }); })), "ci_green");
    onlyFalse(decideFor(fixture((f) => { f[CRUNS].workflow_runs[0].conclusion = "cancelled"; })), "ci_green");
  });
  test("the label is not on the pull request", () => {
    onlyFalse(decideFor(fixture((f) => { f[PR].labels = [{ name: "mini-app:automerge-x" }]; })), "label_present");
  });
  test("the label was added by a read-only or triage user (triage can label)", () => {
    for (const role of ["read", "triage", "none", undefined]) {
      onlyFalse(decideFor(fixture((f) => { f[PERM].role_name = role; f[PERM].permission = "read"; })), "label_by_writer");
    }
  });
  test("the labeler's permission cannot be read, is for another login, or the labeler is a bot", () => {
    onlyFalse(decideFor(fixture((f) => { delete f[PERM]; })), "label_by_writer");
    onlyFalse(decideFor(fixture((f) => { f[PERM].user.login = "someone-else"; })), "label_by_writer");
    onlyFalse(decideFor(fixture((f) => { labeled(f).actor.type = "Bot"; })), "label_by_writer");
  });
  test("the label was added before the last push", () => {
    onlyFalse(decideFor(fixture((f) => { labeled(f).created_at = "2026-10-23T15:50:00Z"; })), "label_after_push");
    onlyFalse(decideFor(fixture((f) => { labeled(f).created_at = "2026-10-23T15:59:57Z"; })), "label_after_push");
  });
  test("a force push after the label invalidates it (even when the old runs are older)", () => {
    onlyFalse(decideFor(fixture((f) => {
      f[TIMELINE].push({ actor: { login: "someone-outside", type: "User" }, created_at: "2026-10-23T16:20:00Z", event: "head_ref_force_pushed" });
    })), "label_after_push");
  });
  test("a newer run for the head (a push back to an old sha) after the label invalidates it", () => {
    onlyFalse(decideFor(fixture((f) => {
      const later = { ...structuredClone(f[CRUNS].workflow_runs[0]), id: 39983100000, run_number: 2211, created_at: "2026-10-23T16:30:00Z" };
      f[CRUNS].workflow_runs.unshift(later);
      f[P("actions/runs/39983100000/jobs?filter=latest&per_page=100")] = structuredClone(f[CJOBS]);
      for (const j of f[P("actions/runs/39983100000/jobs?filter=latest&per_page=100")].jobs) j.run_id = 39983100000;
    })), "label_after_push");
  });
  test("the last label event is an unlabel (the label list and the timeline disagree)", () => {
    onlyFalse(decideFor(fixture((f) => {
      f[TIMELINE].push({ actor: { login: "village-maintainer", type: "User" }, created_at: "2026-10-23T16:11:00Z", event: "unlabeled", label: { name: "mini-app:automerge" } });
    })), "label_by_writer", "label_after_push");
  });
  test("the timeline cannot be read", () => {
    onlyFalse(decideFor(fixture((f) => { delete f[TIMELINE]; })), "label_by_writer", "label_after_push");
  });
  test("a malformed timestamp fails closed", () => {
    onlyFalse(decideFor(fixture((f) => { labeled(f).created_at = "tomorrow"; })), "label_after_push");
  });
});

describe("sweep: the switch, the re-read and the merge call", () => {
  test("switch off => 'disabled', exit 0, and not one API call", () => {
    for (const v of [undefined, "", "0"]) {
      const calls = newCalls();
      const throwing: A.Io = {
        get: () => { throw new Error("no API call may happen while the switch is off"); },
        artifactJson: () => { throw new Error("no"); },
        merge: () => { throw new Error("no"); },
        log: (l) => calls.log.push(l),
      };
      expect(A.sweep(throwing, REPO, { MINI_APPS_AUTOMERGE: v })).toBe(0);
      expect(calls.log.join("\n")).toContain("disabled");
    }
  });
  test("switch on, all green => one squash merge of #901 at its head sha; an issue with the label is ignored", () => {
    const calls = newCalls();
    expect(A.sweep(fakeIo(fixture(), calls), REPO, { MINI_APPS_AUTOMERGE: "1" })).toBe(0);
    expect(calls.merge).toEqual([[REPO, 901, H]]);
    expect(calls.get.filter((g) => g.includes("/77"))).toEqual([]);
  });
  test("switch on, one condition false => no merge call", () => {
    const calls = newCalls();
    expect(A.sweep(fakeIo(fixture((f) => { report(f).verdict = "NEEDS_HUMAN"; }), calls), REPO, { MINI_APPS_AUTOMERGE: "1" })).toBe(0);
    expect(calls.merge).toEqual([]);
    expect(calls.log.some((l) => l.includes("merge=false") && l.includes("review_verdict_pass=false"))).toBe(true);
  });
  test("re-read at merge time: a push between the two reads => no merge", () => {
    const calls = newCalls();
    const moved = fixture((f) => { f[PR].head.sha = "4".repeat(40); });
    expect(A.sweep(fakeIo((round) => (round <= 1 ? fixture() : moved), calls), REPO, { MINI_APPS_AUTOMERGE: "1" })).toBe(0);
    expect(calls.merge).toEqual([]);
  });
  test("a refused merge (409, the head moved) => logged, exit 1", () => {
    const calls = newCalls();
    const io = fakeIo(fixture(), calls, () => { throw new Error("HTTP 409 Head branch was modified. ::warning::x"); });
    expect(A.sweep(io, REPO, { MINI_APPS_AUTOMERGE: "1" })).toBe(1);
    expect(calls.log.join("\n")).toContain("merge refused");
    expect(calls.log.join("\n")).not.toContain("::warning");
  });
  test("a merge answer that is not merged:true => exit 1", () => {
    const calls = newCalls();
    expect(A.sweep(fakeIo(fixture(), calls, () => ({ merged: false })), REPO, { MINI_APPS_AUTOMERGE: "1" })).toBe(1);
  });
  test("every decision line is fixed tokens only: PR number, sha, and each condition true/false", () => {
    const calls = newCalls();
    A.sweep(fakeIo(fixture((f) => { f[PR].title = "::set-env name=X::y"; }), calls), REPO, { MINI_APPS_AUTOMERGE: "1" });
    const lines = calls.log.filter((l) => l.includes(" pr=#"));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const l of lines) expect(l).toMatch(/^mini-apps automerge: pr=#\d+ sha=(?:[0-9a-f]{40}|none) merge=(?:true|false)(?: [a-z_]+=(?:true|false))+$/);
    expect(calls.log.join("\n")).not.toContain("set-env");
  });
  test("a bad --repo refuses before any API call", () => {
    const calls = newCalls();
    expect(A.sweep(fakeIo(fixture(), calls), "not a repo", { MINI_APPS_AUTOMERGE: "1" })).toBe(2);
    expect(calls.get).toEqual([]);
  });
});

describe("the workflow file", () => {
  const WF_PATH = join(import.meta.dir, "..", "..", ".github", "workflows", "mini-apps-automerge.yml");
  const text = readFileSync(WF_PATH, "utf8");
  const wf = parse(text);
  const job = wf.jobs?.merge;
  const steps: any[] = job?.steps ?? [];

  test("triggers: workflow_run (bot + CI), schedule, dispatch without inputs; never pull_request(_target)", () => {
    expect(Object.keys(wf.on).sort()).toEqual(["schedule", "workflow_dispatch", "workflow_run"]);
    expect(wf.on.workflow_run.workflows.sort()).toEqual(["mini-apps review", "test"]);
    expect(wf.on.workflow_run.types).toEqual(["completed"]);
    expect(wf.on.workflow_dispatch === null || wf.on.workflow_dispatch?.inputs === undefined).toBe(true);
    expect(text).not.toMatch(/pull_request_target/);
  });
  test("least privilege: nothing at the top, and only the merge job writes", () => {
    expect(wf.permissions).toEqual({});
    expect(Object.keys(wf.jobs)).toEqual(["merge"]);
    expect(job.permissions).toEqual({ contents: "write", "pull-requests": "write", actions: "read", issues: "read" });
    expect(wf.concurrency["cancel-in-progress"]).toBe(false);
  });
  test("only on main of this repository", () => {
    expect(job.if).toContain("github.repository == 'Edge-City/agentvillage'");
    expect(job.if).toContain("github.ref == 'refs/heads/main'");
  });
  test("the kill switch is the first step, uses no action, and gates every later step", () => {
    expect(steps[0].id).toBe("gate");
    expect(steps[0].uses).toBeUndefined();
    expect(steps[0].env.SWITCH).toBe("${{ vars.MINI_APPS_AUTOMERGE }}");
    for (const s of steps.slice(1)) expect(s.if).toBe("steps.gate.outputs.on == 'true'");
  });
  test("switch off = inert: the gate step says disabled and sets on=false for unset, empty, 0, true", () => {
    for (const [v, want] of [[undefined, "false"], ["", "false"], ["0", "false"], ["true", "false"], ["1 ", "false"], ["1", "true"]] as const) {
      const out = join(require("node:os").tmpdir(), `automerge-gate-${process.pid}-${Math.random()}`);
      require("node:fs").writeFileSync(out, "");
      const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", GITHUB_OUTPUT: out };
      if (v !== undefined) env.SWITCH = v;
      const r = spawnSync("bash", ["-e", "-c", steps[0].run], { env, encoding: "utf8" });
      expect(r.status).toBe(0);
      expect(readFileSync(out, "utf8").trim()).toBe(`on=${want}`);
      if (want === "false") expect(r.stdout).toContain("disabled");
      require("node:fs").rmSync(out, { force: true });
    }
  });
  test("never the pull request's code: checkout is this workflow's own commit, no credentials kept", () => {
    const co = steps.filter((s) => String(s.uses ?? "").startsWith("actions/checkout@"));
    expect(co.length).toBe(1);
    expect(co[0].with?.ref).toBeUndefined();
    expect(co[0].with?.repository).toBeUndefined();
    expect(co[0].with?.["persist-credentials"]).toBe(false);
    expect(text).not.toMatch(/github\.event\.pull_request|head_sha|head\.sha|refs\/pull\//);
    for (const s of steps) if (s.run) expect(s.run).not.toContain("${{");
  });
  test("every action is pinned to a full commit sha", () => {
    for (const s of steps) if (s.uses) expect(s.uses).toMatch(/^[a-z0-9-]+\/[a-z0-9-]+@[0-9a-f]{40}$/);
  });
  test("bun runs this repository's script by explicit path with no bunfig, .env, install or tsconfig", () => {
    const run = steps.map((s) => s.run ?? "").join("\n");
    expect(run).toContain("bun --config=/dev/null --no-env-file --no-install --tsconfig-override=/dev/null ./scripts/mini-apps-automerge.ts");
    const env = steps.find((s) => String(s.run ?? "").includes("mini-apps-automerge.ts")).env;
    expect(env.GH_TOKEN).toBe("${{ github.token }}");
    expect(env.MINI_APPS_AUTOMERGE).toBe("${{ vars.MINI_APPS_AUTOMERGE }}");
    expect(Object.keys(env).sort()).toEqual(["GH_TOKEN", "MINI_APPS_AUTOMERGE", "REPO"]);
  });
});
