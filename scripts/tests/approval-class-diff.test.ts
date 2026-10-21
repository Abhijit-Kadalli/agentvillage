/**
 * The approval.md CLASS-DIFF release gate on the overlay side (B-167, lead
 * ruling CLAIMS L15681 (1), EDGEOS-BLOCK): scripts/approval-class-diff.sh and
 * the `class-diff` job in .github/workflows/test.yml.
 *
 * Always: the job runs the script against the PR's base or, on a push or a Tag
 * release call, the previous release tag (fold 1 S-2); approval.md's tool is
 * pinned by full sha; the script's pin reader reads APPROVAL_MD_PINNED as this
 * repo states it; every allowlist entry has a reason, a scope, an acceptance
 * field, and names a recipe this tree ships.
 *
 * With AV_APPROVAL_MD_TOOL_DIR (an approval.md checkout holding the B-167
 * scripts; the class-diff job sets it, and the npm registry must be
 * reachable): three fixture overlays in throwaway git repos, each a base
 * commit pinning core 0.4.5 and a head commit pinning 0.4.6, run through the
 * real script, exit codes read alone:
 * - FLIP: the pre-#427 EdgeOS curl shape, auto at 0.4.5 and a human-only deny
 *   at 0.4.6 from both working directories, fails (exit 1);
 * - HOME: the --url shape with `$EDGEOS_API_KEY` in a header, auto from a
 *   neutral directory at both cores, is a human-only deny at 0.4.6 from the
 *   box's Hermes home (the APRV-522 credential pass), and fails (exit 1);
 * - STAYS: a recipe with no `$` word passes (exit 0);
 * - NEW (B-167N): a recipe only in the head with no declared outcome fails (exit 1),
 *   and passes once expected.json declares exactly what the hook does (exit 0).
 *
 * B-167N NEW-CALLS (Carter L17349, L17375; spec approval L17350; folds P1-P7),
 * the same script and the same real hook: a class other than declared, an
 * expected card that runs auto (hazard B), a limiting entry accepted by anyone
 * but human:carter, a stale or duplicate entry each fail (exit 1); a core move
 * on an unchanged recipe is reported as "changed (core move)" (P3).
 *
 * B-167N fold 1 (review-b's refute CLAIMS L18667; release's half per lead RULING
 * L18671): the previous release is an annotated vX.Y.Z tag on main that main's
 * release/RC-MANIFEST.md names, on every event (S3, N6); the approval.md tool ref
 * must be on approval.md main (M4); an undated acceptance on an unchanged call
 * fails pull requests only and never halts Tag release (S2); live-compare keys by
 * the closed-set rule and never passes an empty run (N4); CODEOWNERS gaps (N7).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";

import { compare } from "../approval-class-diff/live-compare";

// The pin as fetch-url-shape.test.ts declares it, read from its source (importing a test file would
// register its tests a second time here).
const PIN_SOURCE = readFileSync(join(import.meta.dir, "fetch-url-shape.test.ts"), "utf8");
const APPROVAL_MD_PINNED = PIN_SOURCE.match(/^export const APPROVAL_MD_PINNED = "([^"]+)";$/m)?.[1];

/** Whitespace-collapsed text with shell line continuations joined, as the corpus extractor joins them. */
const flat = (text: string): string => text.replace(/\\\s*\n/g, " ").replace(/\s+/g, " ");

const REPO = join(import.meta.dir, "..", "..");
const SCRIPT = join(REPO, "scripts", "approval-class-diff.sh");
const ALLOWLIST = join(REPO, "scripts", "approval-class-diff", "allowlist.json");
const EXPECTED = join(REPO, "scripts", "approval-class-diff", "expected.json");
const TOOL = process.env.AV_APPROVAL_MD_TOOL_DIR;

describe("the class-diff job and script (static)", () => {
  const wf = parse(readFileSync(join(REPO, ".github", "workflows", "test.yml"), "utf8"));
  const job = wf.jobs?.["class-diff"];
  type Step = { id?: string; uses?: string; with?: Record<string, string | number>; run?: string; env?: Record<string, string> };

  test("test.yml carries the job, so Tag release runs it at the commit it tags", () => {
    expect(job).toBeDefined();
    const steps: Step[] = job.steps;
    const tool = steps.find((s) => s.with?.repository === "approval-md/approval.md");
    expect(String(tool?.with?.ref)).toMatch(/^[0-9a-f]{40}$/);
    expect(steps.some((s) => (s.run ?? "").includes('bash scripts/approval-class-diff.sh "$BASE_REF"'))).toBe(true);
    // No scope step: the gate runs on every event, docs-only pull requests included.
    expect(steps.some((s) => s.id === "scope")).toBe(false);
  });

  test("S-2 + B-167N fold 1 (S3, N6): every event, a pull request included, measures against the previous release, found by previous-release.sh, never by `git describe` over any v* tag", () => {
    const steps: Step[] = job.steps;
    expect(steps[0]?.with?.["fetch-depth"]).toBe(0);
    const base = steps.find((s) => s.id === "base");
    expect(base?.run).toContain("bash scripts/approval-class-diff/previous-release.sh HEAD^ origin/main");
    expect(base?.run).not.toContain("git describe");
    // N6: a pull request is measured from the release as main's push run is, never from its own base.
    expect(base?.run).not.toContain("HEAD^1");
    expect(base?.run).not.toContain("pull_request");
    expect(base?.run).toContain('echo "ref=$base" >> "$GITHUB_OUTPUT"');
    expect(base?.run).toContain('echo "tag=$tag_ref" >> "$GITHUB_OUTPUT"');
    // No release found is a failure, never a silent fall back to HEAD^1.
    expect(base?.run).toContain("exit 1");
  });

  test("the script's pin reader reads APPROVAL_MD_PINNED exactly", () => {
    const text = readFileSync(SCRIPT, "utf8");
    const sed = text.match(/^pin_of\(\) \{ sed -n '([^']+)'; \}$/m);
    expect(sed).not.toBeNull();
    const out = spawnSync("sed", ["-n", sed![1], join(REPO, "scripts", "tests", "fetch-url-shape.test.ts")], { encoding: "utf8" });
    expect(out.status).toBe(0);
    expect(APPROVAL_MD_PINNED).toBeDefined();
    expect(out.stdout.trim()).toBe(APPROVAL_MD_PINNED!);
  });

  test("every allowlist entry has a reason, a scope and an acceptance field, and names a recipe or README this tree ships", () => {
    const allowlist = JSON.parse(readFileSync(ALLOWLIST, "utf8")) as {
      entries: { file: string; command: string; reason: string; scope?: string; accepted_by?: string; accepted_at?: string }[];
    };
    for (const entry of allowlist.entries) {
      expect(entry.reason.trim().length).toBeGreaterThan(12);
      expect(["neutral", "box", "any"]).toContain(entry.scope ?? "any");
      expect(typeof entry.accepted_by).toBe("string");
      expect(typeof entry.accepted_at).toBe("string");
      const text = readFileSync(join(REPO, entry.file), "utf8");
      if (entry.command !== "*") expect(flat(text)).toContain(flat(entry.command));
    }
  });

  test("B-167N P1 + fold 1 N7: CODEOWNERS names expected.json, the gate's files, the gated-tool list it reads, the release enforcement point, the manifest the release rule reads, and these tests", () => {
    const owners = readFileSync(join(REPO, ".github", "CODEOWNERS"), "utf8");
    for (const path of [
      "/scripts/approval-class-diff/expected.json",
      "/scripts/approval-class-diff/",
      "/scripts/approval-class-diff.sh",
      "/.github/workflows/test.yml",
      "/install/install_approval.ts",
      "/.github/workflows/tag-release.yml",
      "/scripts/tag-release.ts",
      "/scripts/tests/approval-class-diff.test.ts",
      "/release/RC-MANIFEST.md",
    ]) {
      expect(owners).toMatch(new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\s+@soycarts$`, "m"));
    }
  });

  test("B-167N: the job measures new calls against the previous release tag and passes it to the script", () => {
    const steps: Step[] = job.steps;
    const base = steps.find((s) => s.id === "base");
    expect(base?.run).toContain('echo "tag=$tag_ref" >> "$GITHUB_OUTPUT"');
    const gate = steps.find((s) => (s.run ?? "").includes('bash scripts/approval-class-diff.sh "$BASE_REF"'));
    expect(gate?.env?.AV_NEW_CALLS_BASE_REF).toBe("${{ steps.base.outputs.tag }}");
  });

  test("B-167N fold 1 M4: the approval.md tool ref must be on approval.md main, checked after the tool checkout and before the gate runs", () => {
    const steps: Step[] = job.steps;
    const at = (pred: (s: Step) => boolean): number => steps.findIndex(pred);
    const checkout = at((s) => s.with?.repository === "approval-md/approval.md");
    const onMain = at((s) => (s.run ?? "").includes("bash scripts/approval-class-diff/tool-ref-on-main.sh .test-deps/approval-md-tool"));
    const gate = at((s) => (s.run ?? "").includes('bash scripts/approval-class-diff.sh "$BASE_REF"'));
    expect(checkout).toBeGreaterThan(-1);
    expect(onMain).toBeGreaterThan(checkout);
    expect(gate).toBeGreaterThan(onMain);
    // No continue-on-error and no `if:` on the ancestry step: it gates the job.
    const step = steps[onMain] as Step & { "continue-on-error"?: unknown; if?: unknown };
    expect(step["continue-on-error"]).toBeUndefined();
    expect(step.if).toBeUndefined();
  });

  test("B-167N fold 1 S2: a pending acceptance fails a pull request and only warns on main's push run and a Tag release call", () => {
    const steps: Step[] = job.steps;
    const gate = steps.find((s) => (s.run ?? "").includes('bash scripts/approval-class-diff.sh "$BASE_REF"'));
    expect(gate?.env?.AV_NEW_CALLS_PENDING_ACCEPTANCE).toBe("${{ github.event_name == 'pull_request' && 'fail' || 'warn' }}");
    // The script's default is fail (fail closed when the variable is missing).
    expect(readFileSync(SCRIPT, "utf8")).toContain('pending=${AV_NEW_CALLS_PENDING_ACCEPTANCE:-fail}');
  });

  test("B-167N: every expected.json entry names a recipe this tree ships or a manifest operation, and a limiting one names human:carter", () => {
    type Layer = { class: string; decision: string; card_style?: string; matrix: Record<string, string> };
    const doc = JSON.parse(readFileSync(EXPECTED, "utf8")) as {
      entries: (Layer & { file?: string; command?: string; tool?: string; input?: Record<string, unknown>; reason: string; owner: string; template: string; accepted_by?: string; accepted_at?: string; propose?: Layer & { key: string } })[];
    };
    const keys = new Set<string>();
    for (const e of doc.entries) {
      expect(e.template).toBe("village default");
      expect(e.reason.trim().length).toBeGreaterThan(12);
      expect(Object.keys(e.matrix).sort()).toEqual(["ask", "autonomous", "manual", "supervised-live", "supervised-retro"]);
      if (e.file !== undefined) {
        expect(flat(readFileSync(join(REPO, e.file), "utf8"))).toContain(flat(e.command!));
        keys.add(`${e.file}\u0000${flat(e.command!).trim()}`);
      } else {
        expect(e.tool).toBe("village");
        const op = String(e.input?.operation);
        const appId = e.input?.appId as string | undefined;
        const manifests = ["dizko", "forkicks", "gold-stars", "mosaic", "slopfolio", "zzzbot"].map((id) => JSON.parse(readFileSync(join(REPO, "mini-apps", id, "manifest.json"), "utf8")) as { id: string; operations: { name: string; target?: { tool: string } }[]; data?: unknown });
        const named = manifests.some((m) => m.operations.some((o) => o.name === op || (op === "mini-app.read" && m.id === appId && o.target?.tool === e.input?.tool)) || (op.startsWith("mini-app.context.") && m.id === appId && m.data !== undefined));
        expect(named).toBe(true);
        keys.add(`${op}:${appId ?? ""}.${String(e.input?.tool ?? "")}`);
      }
      const limiting = [e, ...(e.propose ? [e.propose] : [])].some((l) => l.decision !== "auto" || l.class === "marketplace.app.action");
      if (limiting) {
        expect(e.accepted_by).toBe("human:carter");
        // Carter fills the date; until then the gate fails closed on it (B-167N P1).
        expect(e.accepted_at).toMatch(/^(\d{4}-\d{2}-\d{2}|YYYY-MM-DD)$/);
      }
    }
    expect(keys.size).toBe(doc.entries.length);
    // The For Kicks order's purchase card, the reason P1 exists (approval L17395).
    const order = doc.entries.find((e) => e.input?.operation === "forkicks.order.confirm");
    expect(order?.propose?.class).toBe("marketplace.app.action");
    expect(order?.propose?.decision).toBe("card");
    expect(order?.propose?.card_style).toBe("minimal");
    expect(order?.propose?.key).toBe("marketplace.app.action:forkicks.order.confirm:" + String(order?.input?.draftId));
    expect(order?.reason).toBe("a purchase always asks");
    // B-172 cancelled: EdgeOS RSVP runs on its own, no card, today.
    const rsvp = doc.entries.filter((e) => e.file === "skills/edgeos/SKILL.md" && /edgeos\.ts rsvp/.test(e.command ?? ""));
    expect(rsvp.length).toBe(2);
    for (const e of rsvp) expect([e.decision, e.card_style]).toEqual(["auto", undefined]);
  });
});

describe("B-167N P7: the live decision lines compare with expected.json mechanically", () => {
  const entries = (JSON.parse(readFileSync(EXPECTED, "utf8")) as { entries: Parameters<typeof compare>[0] }).entries;
  const CORE = "0.4.7";
  test("the For Kicks order's two layers and an EdgeOS RSVP, as declared, match; a moved one blocks", () => {
    const good = [
      `marketplace.app.read | auto | none | ${CORE} | village#forkicks.order.confirm`,
      `marketplace.app.action | card | minimal | ${CORE} | marketplace.app.action:forkicks.order.confirm:live-draft-1`,
      `exec.local | auto | none | ${CORE} | bun skills/edgeos/scripts/edgeos.ts rsvp {event_id}`,
    ].join("\n");
    expect(compare(entries, good, CORE).map((r) => r.ok)).toEqual([true, true, true]);
    // Hazard B on the canary: the purchase ran with no card.
    const hazard = compare(entries, `marketplace.app.action | auto | none | ${CORE} | marketplace.app.action:forkicks.order.confirm:live-draft-1`, CORE);
    expect(hazard[0]?.ok).toBe(false);
    expect(hazard[0]?.why.join(";")).toContain("decision auto, declared card");
    // The canary on the fleet tag, not the candidate.
    expect(compare(entries, `exec.local | auto | none | 0.4.6 | bun skills/edgeos/scripts/edgeos.ts rsvp {event_id}`, CORE)[0]?.why.join(";")).toContain("not the candidate's");
    // A technical card, an unknown key, a line not in the format.
    expect(compare(entries, `marketplace.app.action | card | technical | ${CORE} | marketplace.app.action:forkicks.order.confirm:d`, CORE)[0]?.ok).toBe(false);
    expect(compare(entries, `network.call | auto | none | ${CORE} | curl https://example.com/`, CORE)[0]?.why.join(";")).toContain("no expected.json entry");
    expect(compare(entries, "marketplace.app.read auto", CORE)[0]?.ok).toBe(false);
  });
});

// --- B-167N fold 1 (review-b's refute, CLAIMS L18667; release's half, lead RULING L18671) -----------

const GIT_ID = ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "init.defaultBranch=main"];
function gitOut(cwd: string, ...args: string[]): string {
  const out = spawnSync("git", [...GIT_ID, ...args], { cwd, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`);
  return out.stdout.trim();
}
function commitOn(dir: string, name: string, files: Record<string, string> = {}): string {
  put(dir, `log/${name}.txt`, `${name}\n`);
  for (const [path, text] of Object.entries(files)) put(dir, path, text);
  gitOut(dir, "add", "-A");
  gitOut(dir, "commit", "-q", "-m", name);
  return gitOut(dir, "rev-parse", "HEAD");
}
const manifest = (lines: string[]): string => `# Release manifest\n\n\`\`\`rc-manifest\n# approved tags\n${lines.join("\n")}\n\`\`\`\n`;

describe("B-167N fold 1 S3 + N6: the previous release is an annotated vX.Y.Z tag on main that main's release/RC-MANIFEST.md names with its commit", () => {
  const PREV = join(REPO, "scripts", "approval-class-diff", "previous-release.sh");
  const prev = (cwd: string, ...args: string[]) => spawnSync("bash", [PREV, ...args], { cwd, encoding: "utf8" });

  test("a lightweight, rc, unlisted, mislisted, twice-listed or off-main tag never re-baselines; the highest valid one wins; none found exits 1", () => {
    const dir = mkdtempSync(join(root, "prev-"));
    gitOut(dir, "init", "-q");
    const c0 = commitOn(dir, "c0");
    const c1 = commitOn(dir, "c1");
    gitOut(dir, "tag", "-a", "v1.0.0", "-m", "release v1.0.0", c1);
    const c2 = commitOn(dir, "c2");
    gitOut(dir, "tag", "-a", "v1.0.1", "-m", "release v1.0.1", c2);
    const c3 = commitOn(dir, "c3");
    gitOut(dir, "tag", "v1.0.5", c3); // lightweight, though the manifest lists it
    gitOut(dir, "tag", "-a", "v1.0.2", "-m", "not in the manifest", c3);
    gitOut(dir, "tag", "-a", "v1.1.0-rc1", "-m", "an rc", c3);
    gitOut(dir, "tag", "-a", "v9", "-m", "not vX.Y.Z", c3);
    const c4 = commitOn(dir, "c4");
    gitOut(dir, "tag", "-a", "v1.0.3", "-m", "the manifest names another commit", c4);
    gitOut(dir, "tag", "-a", "v1.0.6", "-m", "the manifest names it twice", c4);
    const lines = [`v1.0.0 = ${c1}`, `v1.0.1 = ${c2} # a comment`, `v1.0.5 = ${c3}`, `v1.1.0-rc1 = ${c3}`, `v9 = ${c3}`, `v1.0.3 = ${c2}`, `v1.0.6 = ${c4}`, `v1.0.6 = ${c3}`];
    // A side branch (never on main) carrying a listed annotated tag, merged into a feature branch.
    gitOut(dir, "checkout", "-q", "-b", "side", c4);
    const s1 = commitOn(dir, "s1");
    gitOut(dir, "tag", "-a", "v2.0.0", "-m", "off main", s1);
    gitOut(dir, "checkout", "-q", "main");
    const c5 = commitOn(dir, "c5", { "release/RC-MANIFEST.md": manifest([...lines, `v2.0.0 = ${s1}`]) });
    gitOut(dir, "checkout", "-q", "-b", "feat", s1);
    gitOut(dir, "merge", "-q", "--no-ff", "-m", "merge main", "main");
    const f1 = gitOut(dir, "rev-parse", "HEAD");
    const r = prev(dir, f1, "main");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(`v1.0.1 ${c2}`);
    // A later listed release on main is the one picked (highest version, not the first found).
    gitOut(dir, "checkout", "-q", "main");
    gitOut(dir, "tag", "-a", "v1.0.10", "-m", "release v1.0.10", c5);
    const c6 = commitOn(dir, "c6", { "release/RC-MANIFEST.md": manifest([...lines, `v2.0.0 = ${s1}`, `v1.0.10 = ${c5}`]) });
    expect(prev(dir, c6, "main").stdout.trim()).toBe(`v1.0.10 ${c5}`);
    // The manifest is read from main, never from the commit measured: a branch that lists v1.0.2 changes nothing.
    gitOut(dir, "checkout", "-q", "-b", "forged", c6);
    const g1 = commitOn(dir, "g1", { "release/RC-MANIFEST.md": manifest([...lines, `v1.0.10 = ${c5}`, `v1.0.2 = ${c3}`, `v1.0.11 = ${c6}`]) });
    gitOut(dir, "tag", "-a", "v1.0.11", "-m", "listed only on the branch", c6);
    expect(prev(dir, g1, "main").stdout.trim()).toBe(`v1.0.10 ${c5}`);
    // Nothing valid below: exit 1. No main ref: exit 2.
    expect(prev(dir, c0, "main").status).toBe(1);
    expect(prev(dir, c6, "no-such-main").status).toBe(2);
  });
});

describe("B-167N fold 1 M4: the approval.md tool ref must be an ancestor of approval.md main", () => {
  const ON_MAIN = join(REPO, "scripts", "approval-class-diff", "tool-ref-on-main.sh");
  test("a ref on main passes; an unmerged PR head, or a commit upstream never had, fails", () => {
    const up = mkdtempSync(join(root, "aprv-up-"));
    gitOut(up, "init", "-q");
    const m1 = commitOn(up, "m1");
    const m2 = commitOn(up, "m2");
    gitOut(up, "checkout", "-q", "-b", "pr", m2);
    const p1 = commitOn(up, "p1");
    gitOut(up, "checkout", "-q", "main");
    const tool = join(mkdtempSync(join(root, "aprv-tool-")), "tool");
    gitOut(root, "clone", "-q", up, tool);
    const at = (sha: string) => {
      gitOut(tool, "checkout", "-q", "--detach", sha);
      return spawnSync("bash", [ON_MAIN, tool, up], { encoding: "utf8" });
    };
    expect(at(m1).status).toBe(0);
    expect(at(m2).status).toBe(0);
    const pr = at(p1);
    expect(pr.status).toBe(1);
    expect(pr.stdout + pr.stderr).toContain("is not on approval.md main");
    gitOut(tool, "checkout", "-q", "--detach", m2);
    const local = commitOn(tool, "local-only");
    expect(at(local).status).toBe(1);
    expect(spawnSync("bash", [ON_MAIN], { encoding: "utf8" }).status).toBe(2);
  });
});

describe("B-167N fold 1 S2: a pending accepted_at on an UNCHANGED call is the only finding a push or Tag release run may pass with a warning", () => {
  const PENDING_MSG = 'LIMITING (propose decision card; propose class marketplace.app.action defaults to manual): awaiting acceptance: accepted_at "YYYY-MM-DD" is not a YYYY-MM-DD date (Carter fills it)';
  const NEWCALLS_ERR = "1 new-calls finding(s) (B-167N): a new or changed call with no declared outcome, an outcome other than declared, a limiting entry without Carter's acceptance, or a stale entry. Declare the call in expected.json, fix the call, or have Carter accept it by name.";
  const KEY = "village#forkicks.order.confirm";
  const row = (over: Entry = {}): Entry => ({ key: KEY, kind: "envelope", status: "unchanged", entry: true, blocks: [PENDING_MSG], ...over });
  const doc = (rows: Entry[], findings: Entry[], over: Entry = {}): Entry => ({ summary: { blocking: 0 }, shadowed: [], newCalls: { rows, findings }, ...over });
  const finding = (message = PENDING_MSG, key = KEY): Entry => ({ key, message });

  test("waived only when every finding is that pending date on an unchanged call and nothing else complained", async () => {
    const { pendingOnly } = (await import("../approval-class-diff/pending-acceptance")) as { pendingOnly: (d: unknown, err: string) => { ok: boolean; waived: string[]; why: string[] } };
    const ok = pendingOnly(doc([row()], [finding()]), `${NEWCALLS_ERR}\n`);
    expect(ok.ok).toBe(true);
    expect(ok.waived).toEqual([KEY]);
    // A NEW or CHANGED call's pending acceptance fails everywhere: a new limitation never ships unaccepted.
    expect(pendingOnly(doc([row({ status: "new" })], [finding()]), NEWCALLS_ERR).ok).toBe(false);
    expect(pendingOnly(doc([row({ status: "changed (core move)" })], [finding()]), NEWCALLS_ERR).ok).toBe(false);
    // accepted_by is never waived, nor is any other block on the row.
    const by = 'LIMITING (propose decision card): awaiting acceptance: accepted_by must be "human:carter" (it is "human:test")';
    expect(pendingOnly(doc([row({ blocks: [by] })], [finding(by)]), NEWCALLS_ERR).ok).toBe(false);
    expect(pendingOnly(doc([row({ blocks: [PENDING_MSG, "propose: decision auto, declared card"] })], [finding(), finding("propose: decision auto, declared card")]), NEWCALLS_ERR).ok).toBe(false);
    // Any other complaint from the check (a box deny, a stale allowlist entry), a class-diff block or a shadowed line: no waiver.
    expect(pendingOnly(doc([row()], [finding()]), `${NEWCALLS_ERR}\nstale allowlist entry (nothing held or blocked matches it; delete it): a: b\n`).ok).toBe(false);
    expect(pendingOnly(doc([row()], [finding()], { summary: { blocking: 1 } }), NEWCALLS_ERR).ok).toBe(false);
    expect(pendingOnly(doc([row()], [finding()], { summary: undefined }), NEWCALLS_ERR).ok).toBe(false);
    expect(pendingOnly(doc([row()], [finding()], { shadowed: [{ index: 1 }] }), NEWCALLS_ERR).ok).toBe(false);
    // Nothing pending (the check failed for another reason) or no new-calls section: no waiver.
    expect(pendingOnly(doc([], []), "no corpus at x\n").ok).toBe(false);
    expect(pendingOnly({ summary: { blocking: 0 }, shadowed: [] }, NEWCALLS_ERR).ok).toBe(false);
    // A finding naming a key no row carries: no waiver.
    expect(pendingOnly(doc([row()], [finding(PENDING_MSG, "village#forkicks.menu")]), NEWCALLS_ERR).ok).toBe(false);
  });
});

describe("B-167N fold 1 N4: live-compare keys calls by approval.md's closed-set rule and never passes an empty run", () => {
  const LIVE = join(REPO, "scripts", "approval-class-diff", "live-compare.ts");
  const live = (lines: string, ...args: string[]) => {
    const dir = mkdtempSync(join(root, "live-"));
    writeFileSync(join(dir, "lines.txt"), lines);
    return spawnSync("bun", [LIVE, "--lines", join(dir, "lines.txt"), "--core", "0.4.7", ...args], { encoding: "utf8" });
  };
  const report = (rows: Entry[]): string => {
    const dir = mkdtempSync(join(root, "live-report-"));
    writeFileSync(join(dir, "class-diff.json"), JSON.stringify({ newCalls: { rows, findings: [] } }));
    return join(dir, "class-diff.json");
  };
  const SEARCH = "village#mini-app.read:dizko.search_events";

  test("a key part carrying a separator, or not a string, keys nothing, so it never stands for a real call", async () => {
    const { envelopeKey } = (await import("../approval-class-diff/live-compare")) as { envelopeKey: (t: string, i?: Record<string, unknown>) => string | null };
    expect(envelopeKey("village", { operation: "mini-app.read", appId: "dizko", tool: "search_events" })).toBe(SEARCH);
    expect(envelopeKey("village", { operation: "mini-app.read:dizko", tool: "search_events" })).toBeNull();
    expect(envelopeKey("village", { operation: "a", appId: "b.c" })).toBeNull();
    expect(envelopeKey("village", { operation: 1 })).toBeNull();
    expect(envelopeKey("vil#lage", {})).toBeNull();
    const forged = [{ tool: "village", input: { operation: "mini-app.read:dizko", tool: "search_events" }, class: "marketplace.app.read", decision: "auto" }];
    expect(compare(forged, `marketplace.app.read | auto | none | 0.4.7 | ${SEARCH}`, "0.4.7")[0]?.ok).toBe(false);
  });

  test("an empty lines file fails; naming nothing to cover is a usage error; --report requires a line for every NEW or CHANGED declared call and its propose", () => {
    expect(live("# nothing read\n\n", "--require", SEARCH).status).toBe(1);
    expect(live("", "--report", report([])).status).toBe(1);
    const one = `marketplace.app.read | auto | none | 0.4.7 | ${SEARCH}\n`;
    expect(live(one).status).toBe(2);
    expect(live(one, "--report", report([{ key: SEARCH, kind: "envelope", status: "new", entry: true }])).status).toBe(0);
    expect(live(one, "--report", report([{ key: SEARCH, kind: "envelope", status: "new", entry: true }, { key: "village#mini-app.read:dizko.get_event", kind: "envelope", status: "new", entry: true }])).status).toBe(1);
    // An unchanged row needs no live line.
    expect(live(one, "--report", report([{ key: SEARCH, kind: "envelope", status: "new", entry: true }, { key: "village#forkicks.menu", kind: "envelope", status: "unchanged", entry: true }])).status).toBe(0);
    // A changed call with a propose needs both lines; the propose is matched by its action key's stem.
    const order = [{ key: "village#forkicks.order.confirm", kind: "envelope", status: "changed (bytes)", entry: true }];
    const hook = "marketplace.app.read | auto | none | 0.4.7 | village#forkicks.order.confirm\n";
    const card = "marketplace.app.action | card | minimal | 0.4.7 | marketplace.app.action:forkicks.order.confirm:live-draft-1\n";
    expect(live(hook, "--report", report(order)).status).toBe(1);
    expect(live(hook + card, "--report", report(order)).status).toBe(0);
    // A recipe row is covered by its command.
    const rsvp = "bun skills/edgeos/scripts/edgeos.ts rsvp {event_id}";
    expect(live(`exec.local | auto | none | 0.4.7 | ${rsvp}\n`, "--report", report([{ key: `skills/edgeos/SKILL.md\u0000${rsvp}`, kind: "recipe", status: "new", entry: true }])).status).toBe(0);
  });
});

// --- fixture overlays through the real script -------------------------------------------------------

const TEMPLATE = readFileSync(join(REPO, "skills", "approval", "templates", "APPROVAL.md"), "utf8");
const PRE_FIX = 'curl -s -H "Authorization: Bearer $EDGEOS_API_KEY" "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/events/portal/events/{event_id}"';
const FIXED = 'curl -s -H "Authorization: Bearer $EDGEOS_API_KEY" --url "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/events/portal/events/{event_id}"';
const OPAQUE = `${FIXED} | python3 -c "import json,sys; print(json.load(sys.stdin))"`;
const STAY = "bun skills/edgeos/scripts/events.ts --when today";
const NEW = "bun skills/edgeos/scripts/events.ts --when tomorrow";

const root = mkdtempSync(join(tmpdir(), "class-diff-fixture-"));
const cores = join(root, "cores");
// The npm core installs make this a large tree: give its removal more than the 5 s hook default.
afterAll(() => rmSync(root, { recursive: true, force: true }), 120_000);

function git(cwd: string, ...args: string[]): void {
  const out = spawnSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`);
}

function put(dir: string, path: string, text: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

type Entry = Record<string, unknown>;
const READ_MATRIX = { ask: "card", autonomous: "auto", "supervised-retro": "auto", "supervised-live": "sampled", manual: "card" };
/** A declared outcome for one fixture recipe (B-167N): what the hook gives a `bun skills/...` run today. */
const declare = (command: string, over: Entry = {}): Entry => ({
  file: "skills/edgeos/SKILL.md",
  command,
  class: "exec.local",
  decision: "auto",
  template: "village default",
  matrix: READ_MATRIX,
  reason: "a fixture recipe that runs on its own",
  owner: "fixture",
  ...over,
});

function tree(dir: string, pin: string, recipes: string[], expected: Entry[] = [], allowlist: Entry[] = []): void {
  put(dir, "scripts/tests/fetch-url-shape.test.ts", `export const APPROVAL_MD_PINNED = "${pin}";\n`);
  put(dir, "skills/approval/templates/APPROVAL.md", TEMPLATE);
  put(dir, "skills/edgeos/SKILL.md", `# EdgeOS\n\n\`\`\`bash\n${recipes.join("\n")}\n\`\`\`\n`);
  put(dir, "skills/edgeos/scripts/events.ts", "console.log(1);\n");
  put(dir, "workspace/README.md", "# workspace\n");
  put(dir, "install/install_index.ts", "export const DIGEST_CRON_SPECS: { name: string; promptBody?: string }[] = [];\n");
  put(dir, "scripts/approval-class-diff/allowlist.json", `${JSON.stringify({ entries: allowlist }, null, 2)}\n`);
  put(dir, "scripts/approval-class-diff/expected.json", `${JSON.stringify({ entries: expected }, null, 2)}\n`);
  put(dir, "install/install_approval.ts", 'export const APPROVAL_GATED_TOOLS = ["terminal"] as const;\n');
}

/** A throwaway overlay repo: a base commit and a head commit, each with a pin and a recipe list. */
function fixture(
  name: string,
  base: [string, string[]],
  head: [string, string[], Entry[]?],
  opts: { allowlist?: Entry[]; env?: Record<string, string> } = {},
): { status: number | null; md: string; err: string; out: string } {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  tree(dir, base[0], base[1]);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  tree(dir, head[0], head[1], head[2] ?? [], opts.allowlist ?? []);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "head");
  const out = join(dir, "report");
  // approval.md's check refuses an expected.json that is not the copy its own
  // checkout pins (B-167N P1 security fold), so each fixture runs a scratch copy
  // of the tool's scripts holding this fixture's expected.json as that copy.
  const tool = join(dir, "tool");
  cpSync(join(TOOL!, "scripts"), join(tool, "scripts"), { recursive: true });
  cpSync(join(dir, "scripts", "approval-class-diff", "expected.json"), join(tool, "scripts", "overlay-recipes", "expected.json"));
  const run = spawnSync("bash", [SCRIPT, "HEAD^1"], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      AV_APPROVAL_MD_TOOL_DIR: tool,
      AV_CLASS_DIFF_OUT: out,
      AV_CLASS_DIFF_CORES: cores,
      // Sequential hook runs over the harness tools a recipe fixture can move.
      AV_CLASS_DIFF_BOX_CONCURRENCY: "1",
      AV_CLASS_DIFF_HARNESS_ONLY: "terminal,send_message",
      // Each fixture states the mode it runs in (B-167N fold 1 S2); unset is the script's fail-closed default.
      AV_NEW_CALLS_PENDING_ACCEPTANCE: "",
      ...opts.env,
    },
  });
  let md = "";
  try {
    md = readFileSync(join(out, "class-diff.md"), "utf8");
  } catch {
    md = `(no report) ${run.stderr}`;
  }
  return { status: run.status, md, err: run.stderr, out: run.stdout };
}

const LONG = 600_000;

describe.skipIf(TOOL === undefined)("fixture overlays through the real script and the real hook in a box", () => {
  test(
    "FLIP: the pre-#427 EdgeOS shape, pin 0.4.5 -> 0.4.6, moves auto -> human-only at every workdir and fails",
    () => {
      const run = fixture("flip", ["0.4.5", [STAY, PRE_FIX]], ["0.4.6", [STAY, PRE_FIX]]);
      expect(run.status).toBe(1);
      expect(run.md).toMatch(/^CLASS-DIFF FAIL 3 BLOCKING: core 0\.4\.5 .*blocking by column: hermes-home 1, home 1, workspace 1/);
    },
    LONG,
  );

  test(
    "HOME: the --url shape with $EDGEOS_API_KEY, pin 0.4.5 -> 0.4.6, is denied from the Hermes home only, and fails",
    () => {
      const run = fixture("home", ["0.4.5", [STAY, FIXED]], ["0.4.6", [STAY, FIXED]]);
      expect(run.status).toBe(1);
      expect(run.md).toMatch(/^CLASS-DIFF FAIL 1 BLOCKING: .*blocking by column: hermes-home 1$/m);
    },
    LONG,
  );

  test(
    "STAYS: a recipe with no $ word, pin 0.4.5 -> 0.4.6, is unchanged everywhere and passes",
    () => {
      const run = fixture("stays", ["0.4.5", [STAY]], ["0.4.6", [STAY]]);
      expect(run.status).toBe(0);
      expect(run.md).toMatch(/^CLASS-DIFF PASS: .*class-diff: none; 0 new, 0 removed/);
    },
    LONG,
  );

  test(
    "NEW (B-167N): a new recipe with no declared outcome fails; never 'reported new' and passed",
    () => {
      const run = fixture("new", ["0.4.6", [STAY]], ["0.4.6", [STAY, NEW]]);
      expect(run.status).toBe(1);
      expect(run.md).toMatch(/^CLASS-DIFF PASS: .*; 4 new, 0 removed/);
      expect(run.md).toMatch(/^NEW-CALLS FAIL \d+ BLOCKING: .*1 new, .*0 declared, 1 undeclared$/m);
      expect(run.md).toContain("--when tomorrow`: new call with no declared outcome");
    },
    LONG,
  );

  test(
    "NEW (B-167N): the same recipe declared as the hook runs it (exec.local, auto, the settings matrix) passes",
    () => {
      const run = fixture("new-declared", ["0.4.6", [STAY]], ["0.4.6", [STAY, NEW], [declare(NEW)]]);
      expect(run.status).toBe(0);
      expect(run.md).toMatch(/^NEW-CALLS PASS: .*1 new, .*1 declared, 0 undeclared$/m);
    },
    LONG,
  );

  test(
    "B-167N: a class other than declared fails",
    () => {
      const run = fixture("new-class", ["0.4.6", [STAY]], ["0.4.6", [STAY, NEW], [declare(NEW, { class: "network.call" })]]);
      expect(run.status).toBe(1);
      expect(run.md).toContain("class exec.local, declared network.call");
    },
    LONG,
  );

  test(
    "B-167N hazard B: a call declared to card (Carter's acceptance on it) that runs auto fails",
    () => {
      const entry = declare(NEW, { decision: "card", card_style: "minimal", accepted_by: "human:carter", accepted_at: "2026-10-21" });
      const run = fixture("new-hazard-b", ["0.4.6", [STAY]], ["0.4.6", [STAY, NEW], [entry]]);
      expect(run.status).toBe(1);
      expect(run.md).toContain("an expected card runs auto (hazard B");
    },
    LONG,
  );

  test(
    "B-167N P1: a limiting entry (a declared refusal) accepted by anyone but human:carter fails; by Carter, with a date, passes",
    () => {
      const refused = { class: "network.call", decision: "deny", reason: "fixture: an opaque pipe the hook refuses, kept on purpose" };
      const other = fixture("limit-other", ["0.4.6", [STAY]], ["0.4.6", [STAY, OPAQUE], [declare(OPAQUE, { ...refused, accepted_by: "human:test", accepted_at: "2026-10-21" })]]);
      expect(other.status).toBe(1);
      expect(other.md).toContain('LIMITING (hook decision deny): awaiting acceptance: accepted_by must be "human:carter"');
      const carter = fixture("limit-carter", ["0.4.6", [STAY]], ["0.4.6", [STAY, OPAQUE], [declare(OPAQUE, { ...refused, accepted_by: "human:carter", accepted_at: "2026-10-21" })]]);
      expect(carter.md).not.toContain("LIMITING (");
    },
    LONG,
  );

  test(
    "B-167N P4: a stale entry, or two entries for one key, fails",
    () => {
      const stale = fixture("stale", ["0.4.6", [STAY]], ["0.4.6", [STAY], [declare("bun skills/edgeos/scripts/events.ts --when never")]]);
      expect(stale.status).toBe(1);
      expect(stale.md).toContain("stale: no recipe or envelope with this key");
      const dup = fixture("dup", ["0.4.6", [STAY]], ["0.4.6", [STAY, NEW], [declare(NEW), declare(`${NEW} `)]]);
      expect(dup.status).toBe(1);
      expect(dup.md).toContain("a second entry for this key");
    },
    LONG,
  );

  test(
    "B-167N P3: a core bump on an UNCHANGED recipe is reported as moved (changed (core move)), never silently unchanged",
    () => {
      const run = fixture("core-move", ["0.4.5", [STAY, FIXED]], ["0.4.6", [STAY, FIXED]]);
      expect(run.status).toBe(1);
      expect(run.md).toMatch(/^NEW-CALLS FAIL \d+ BLOCKING: .*0 new, 1 changed \(0 bytes, 1 core move\)/m);
      expect(run.md).toContain("`: changed (core move) call with no declared outcome");
    },
    LONG,
  );

  test(
    "B-167N fold 1 S2: a pending accepted_at on an UNCHANGED call fails a pull request and only warns on main / Tag release; on a NEW call it fails everywhere",
    () => {
      // The opaque pipe is refused at every workdir and in every settings cell; the box check's deny is allowlisted by Carter.
      const allowlist = [{ file: "skills/edgeos/SKILL.md", command: OPAQUE, reason: "fixture: an opaque pipe the hook refuses, kept on purpose", scope: "any", accepted_by: "human:carter", accepted_at: "2026-10-21" }];
      const refusedEverywhere = { ask: "refused", autonomous: "refused", "supervised-retro": "refused", "supervised-live": "refused", manual: "refused" };
      const pending = declare(OPAQUE, { class: "network.call", decision: "deny", matrix: refusedEverywhere, reason: "fixture: an opaque pipe the hook refuses, kept on purpose", accepted_by: "human:carter", accepted_at: "YYYY-MM-DD" });
      const pr = fixture("pending-pr", ["0.4.6", [STAY, OPAQUE]], ["0.4.6", [STAY, OPAQUE], [pending]], { allowlist, env: { AV_NEW_CALLS_PENDING_ACCEPTANCE: "fail" } });
      expect(pr.status).toBe(1);
      expect(pr.md).toMatch(/^NEW-CALLS FAIL 1 BLOCKING: /m);
      expect(pr.md).toContain("Carter fills it");
      const push = fixture("pending-push", ["0.4.6", [STAY, OPAQUE]], ["0.4.6", [STAY, OPAQUE], [pending]], { allowlist, env: { AV_NEW_CALLS_PENDING_ACCEPTANCE: "warn" } });
      expect(push.status).toBe(0);
      expect(push.md).toContain("NEW-CALLS ACCEPTANCE PENDING (fails pull requests only; B-167N fold 1 S2)");
      expect(push.out).toContain("::warning::");
      // Unset is fail, never warn.
      const unset = fixture("pending-unset", ["0.4.6", [STAY, OPAQUE]], ["0.4.6", [STAY, OPAQUE], [pending]], { allowlist });
      expect(unset.status).toBe(1);
      // The same pending acceptance on a NEW call fails on main too.
      const fresh = fixture("pending-new", ["0.4.6", [STAY]], ["0.4.6", [STAY, OPAQUE], [pending]], { allowlist, env: { AV_NEW_CALLS_PENDING_ACCEPTANCE: "warn" } });
      expect(fresh.status).toBe(1);
      // Control: Carter's date filled, the same tree passes in fail mode.
      const filled = fixture("pending-filled", ["0.4.6", [STAY, OPAQUE]], ["0.4.6", [STAY, OPAQUE], [{ ...pending, accepted_at: "2026-10-21" }]], { allowlist, env: { AV_NEW_CALLS_PENDING_ACCEPTANCE: "fail" } });
      expect(filled.status).toBe(0);
    },
    LONG,
  );

  test(
    "S-1 (ov#427 replayed): a recipe EDITED into a shape the hook denies from the Hermes home fails at an unchanged pin",
    () => {
      const run = fixture("ov427", ["0.4.6", [STAY, PRE_FIX]], ["0.4.6", [STAY, FIXED]]);
      expect(run.status).toBe(1);
      expect(run.err).toMatch(/denied by the real hook in the box layout/);
    },
    LONG,
  );

  test(
    "S-1 (O2): a recipe edited into a refused (opaque) shape fails at an unchanged pin",
    () => {
      const run = fixture("o2", ["0.4.6", [STAY]], ["0.4.6", [STAY, OPAQUE]]);
      expect(run.status).toBe(1);
      expect(run.err).toMatch(/denied by the real hook in the box layout/);
    },
    LONG,
  );
});
