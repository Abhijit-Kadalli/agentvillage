/**
 * The approval.md CLASS-DIFF release gate on the overlay side (B-167, lead
 * ruling CLAIMS L15681 (1), EDGEOS-BLOCK): scripts/approval-class-diff.sh and
 * the `class-diff` job in .github/workflows/test.yml.
 *
 * Always: the job runs the script against the base, approval.md's tool is
 * pinned by full sha, the script's pin reader reads APPROVAL_MD_PINNED as
 * this repo states it, and every allowlist entry has a reason and names a
 * recipe this tree ships.
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
 * - NEW: a recipe only in the head is reported as new and passes (exit 0).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";

// The pin as fetch-url-shape.test.ts declares it, read from its source (importing a test file would
// register its tests a second time here).
const PIN_SOURCE = readFileSync(join(import.meta.dir, "fetch-url-shape.test.ts"), "utf8");
const APPROVAL_MD_PINNED = PIN_SOURCE.match(/^export const APPROVAL_MD_PINNED = "([^"]+)";$/m)?.[1];

/** Whitespace-collapsed text with shell line continuations joined, as the corpus extractor joins them. */
const flat = (text: string): string => text.replace(/\\\s*\n/g, " ").replace(/\s+/g, " ");

const REPO = join(import.meta.dir, "..", "..");
const SCRIPT = join(REPO, "scripts", "approval-class-diff.sh");
const ALLOWLIST = join(REPO, "scripts", "approval-class-diff", "allowlist.json");
const TOOL = process.env.AV_APPROVAL_MD_TOOL_DIR;

describe("the class-diff job and script (static)", () => {
  const wf = parse(readFileSync(join(REPO, ".github", "workflows", "test.yml"), "utf8"));
  const job = wf.jobs?.["class-diff"];

  test("test.yml carries the job, so Tag release runs it at the commit it tags", () => {
    expect(job).toBeDefined();
    const steps: { uses?: string; with?: Record<string, string>; run?: string }[] = job.steps;
    const tool = steps.find((s) => s.with?.repository === "approval-md/approval.md");
    expect(tool?.with?.ref).toMatch(/^[0-9a-f]{40}$/);
    expect(steps.some((s) => (s.run ?? "").includes("bash scripts/approval-class-diff.sh HEAD^1"))).toBe(true);
    // No scope step: the gate runs on every event, docs-only pull requests included.
    expect(steps.some((s) => (s as { id?: string }).id === "scope")).toBe(false);
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

  test("every allowlist entry has a reason and names a recipe this tree ships", () => {
    const allowlist = JSON.parse(readFileSync(ALLOWLIST, "utf8")) as { entries: { file: string; command: string; reason: string }[] };
    for (const entry of allowlist.entries) {
      expect(entry.reason.trim().length).toBeGreaterThan(0);
      expect(flat(readFileSync(join(REPO, entry.file), "utf8"))).toContain(flat(entry.command));
    }
  });
});

// --- fixture overlays through the real script -------------------------------------------------------

const TEMPLATE = readFileSync(join(REPO, "skills", "approval", "templates", "APPROVAL.md"), "utf8");
const PRE_FIX = 'curl -s -H "Authorization: Bearer $EDGEOS_API_KEY" "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/events/portal/events/{event_id}"';
const FIXED = 'curl -s -H "Authorization: Bearer $EDGEOS_API_KEY" --url "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/events/portal/events/{event_id}"';
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

function tree(dir: string, pin: string, recipes: string[]): void {
  put(dir, "scripts/tests/fetch-url-shape.test.ts", `export const APPROVAL_MD_PINNED = "${pin}";\n`);
  put(dir, "skills/approval/templates/APPROVAL.md", TEMPLATE);
  put(dir, "skills/edgeos/SKILL.md", `# EdgeOS\n\n\`\`\`bash\n${recipes.join("\n")}\n\`\`\`\n`);
  put(dir, "workspace/README.md", "# workspace\n");
  put(dir, "install/install_index.ts", "export const DIGEST_CRON_SPECS: { name: string; promptBody?: string }[] = [];\n");
  put(dir, "scripts/approval-class-diff/allowlist.json", '{ "entries": [] }\n');
}

function fixture(name: string, base: string[], head: string[]): { status: number | null; md: string } {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  tree(dir, "0.4.5", base);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  tree(dir, "0.4.6", head);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "head: move the pin");
  const out = join(dir, "report");
  const run = spawnSync("bash", [SCRIPT, "HEAD^1"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, AV_APPROVAL_MD_TOOL_DIR: TOOL, AV_CLASS_DIFF_OUT: out, AV_CLASS_DIFF_CORES: cores },
  });
  let md = "";
  try {
    md = readFileSync(join(out, "class-diff.md"), "utf8");
  } catch {
    md = `(no report) ${run.stderr}`;
  }
  return { status: run.status, md };
}

describe.skipIf(TOOL === undefined)("fixture overlays, core 0.4.5 -> 0.4.6, through the real script", () => {
  test(
    "FLIP: the pre-#427 EdgeOS shape moves auto -> human-only and fails",
    () => {
      const run = fixture("flip", [STAY, PRE_FIX], [STAY, PRE_FIX]);
      expect(run.status).toBe(1);
      expect(run.md).toMatch(/^CLASS-DIFF FAIL 2 BLOCKING: core 0\.4\.5 -> 0\.4\.6.*blocking by cwd: neutral 1, hermes-home 1\)/);
      expect(run.md).toContain("network.call: auto | policy.core: human-only");
    },
    300_000,
  );

  test(
    "HOME: the --url shape with $EDGEOS_API_KEY in a header is denied from the Hermes home at 0.4.6, and fails",
    () => {
      const run = fixture("home", [STAY, FIXED], [STAY, FIXED]);
      expect(run.status).toBe(1);
      expect(run.md).toMatch(/^CLASS-DIFF FAIL 1 BLOCKING: .*blocking by cwd: neutral 0, hermes-home 1\)/);
      expect(run.md).toContain("network.call: auto | account.credential+network.call: human-only");
    },
    300_000,
  );

  test(
    "STAYS: a recipe with no $ word is unchanged in both directories and passes",
    () => {
      const run = fixture("stays", [STAY], [STAY]);
      expect(run.status).toBe(0);
      expect(run.md).toMatch(/^CLASS-DIFF PASS: .*class-diff: none; 0 new, 0 removed/);
    },
    300_000,
  );

  test(
    "NEW: a recipe only in the head is reported new and passes",
    () => {
      const run = fixture("new", [STAY], [STAY, NEW]);
      expect(run.status).toBe(0);
      expect(run.md).toMatch(/^CLASS-DIFF PASS: .*; 1 new, 0 removed/);
      expect(run.md).toContain("### New calls (reported, not gated): 1");
    },
    300_000,
  );
});
