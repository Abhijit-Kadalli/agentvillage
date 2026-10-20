import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { stagePlugins } from "../install_approval";
import { EDGE_SKILL_NAMES, RETIRED_SKILL_DIRS } from "../paths";
import { copySkillBundles } from "../skill_copy";

// BUG-esmeralda (20 Oct 2026): a resident's agent "keeps asking about Edge
// Esmeralda", the summer V1 village. This is Edge City India. Every word the
// agent can load comes from what the installer puts on the box, so this test
// stages that set the way the installer does and requires zero mentions of the
// previous village, except the entries below, each pinned with a reason.
//
// The set: workspace/*.md (install.ts copyWorkspaceFiles, SOUL.md included),
// skills/<EDGE_SKILL_NAMES> staged by copySkillBundles, every other skill
// directory under skills/ that is not retired (the approval skill and the
// mini-app skills are installed by their own steps), plugins/ staged by
// stagePlugins, and mini-apps/.
const REPO = join(import.meta.dir, "..", "..");
const PATTERN = /esmeralda/i;

/** A path prefix (directory, ends with "/") or one file, its exact hit count (or "any" for a prefix), and why. */
const ALLOWED: ReadonlyArray<{ path: string; hits: number | "any"; reason: string }> = [
  {
    path: "workspace/AGENTS.md",
    hits: 3,
    reason:
      "FROZEN file: Carter owns its edit (BUG-esmeralda.md has the three lines and their replacements). " +
      "Pinned to the exact count, so a new mention fails here and Carter's edit must lower this entry.",
  },
  {
    path: "skills/edge-india/references/",
    hits: "any",
    reason:
      "Verbatim copy of Edge City's public website and newsletter pages (scripts/sync-india-references.ts, " +
      "refreshed every 30 min). They name earlier villages as Edge City's history; they are reference " +
      "material read on demand, never instructions, and editing them by hand is undone by the next sync.",
  },
  {
    path: "skills/edge-india/scripts/tests/",
    hits: "any",
    reason:
      "Test code staged with the bundle (copySkillBundles copies the whole tree) but never loaded into the " +
      "agent's context; its guards must name the previous village to keep it out of the India skill.",
  },
  {
    path: "skills/edgeos/scripts/tests/",
    hits: "any",
    reason:
      "Test code staged with the bundle but never loaded into the agent's context; it uses the previous " +
      "popup's id as a known foreign popup for the directory script's --popup override.",
  },
];

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "av-no-previous-village-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function walk(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

/** `{ "<shipped path>": hits }` for every file in `root` that mentions the previous village. */
function hits(root: string, as: (rel: string) => string): Record<string, number> {
  const found: Record<string, number> = {};
  for (const file of walk(root)) {
    const bytes = readFileSync(file);
    if (bytes.includes(0)) continue; // binary
    const n = bytes.toString("utf8").split("\n").filter((line) => PATTERN.test(line)).length;
    if (n > 0) found[as(relative(root, file).split(sep).join("/"))] = n;
  }
  return found;
}

/** Stages the shipped set into `home` and returns every hit by its path in the repo. */
function shippedHits(): Record<string, number> {
  const found: Record<string, number> = {};
  for (const entry of readdirSync(join(REPO, "workspace"))) {
    if (!entry.endsWith(".md")) continue;
    const n = readFileSync(join(REPO, "workspace", entry), "utf8").split("\n").filter((line) => PATTERN.test(line)).length;
    if (n > 0) found[`workspace/${entry}`] = n;
  }
  const skills = join(home, "skills");
  copySkillBundles(join(REPO, "skills"), skills);
  Object.assign(found, hits(skills, (rel) => `skills/${rel}`));
  const shipped = new Set<string>(EDGE_SKILL_NAMES);
  const retired = new Set<string>(RETIRED_SKILL_DIRS);
  for (const entry of readdirSync(join(REPO, "skills"))) {
    const dir = join(REPO, "skills", entry);
    if (!statSync(dir).isDirectory() || shipped.has(entry) || retired.has(entry)) continue;
    Object.assign(found, hits(dir, (rel) => `skills/${entry}/${rel}`));
  }
  const plugins = join(home, "plugins");
  stagePlugins(join(REPO, "plugins"), plugins, "before-approval");
  Object.assign(found, hits(plugins, (rel) => `plugins/${rel}`));
  Object.assign(found, hits(join(REPO, "mini-apps"), (rel) => `mini-apps/${rel}`));
  return found;
}

function allowedBy(path: string) {
  return ALLOWED.find((entry) => (entry.path.endsWith("/") ? path.startsWith(entry.path) : path === entry.path));
}

test("BUG-esmeralda: the shipped prompt and skill set never names the previous village outside the pinned allowlist", () => {
  const found = shippedHits();
  const unexpected = Object.entries(found).filter(([path, n]) => {
    const entry = allowedBy(path);
    return !entry || (entry.hits !== "any" && entry.hits !== n);
  });
  expect(Object.fromEntries(unexpected)).toEqual({});
  // A pinned file that drops to zero must leave the allowlist too (Carter's AGENTS.md edit).
  for (const entry of ALLOWED) {
    if (entry.hits === "any") continue;
    expect({ path: entry.path, hits: found[entry.path] ?? 0 }).toEqual({ path: entry.path, hits: entry.hits });
  }
});

test("BUG-esmeralda: the previous popup's skill is retired, so the installer removes it from every box", () => {
  expect(EDGE_SKILL_NAMES as readonly string[]).not.toContain("edge-esmeralda");
  expect(RETIRED_SKILL_DIRS as readonly string[]).toContain("edge-esmeralda");
  copySkillBundles(join(REPO, "skills"), join(home, "skills"));
  expect(readdirSync(join(home, "skills"))).not.toContain("edge-esmeralda");
});

test("BUG-esmeralda: every allowlist entry says why", () => {
  for (const entry of ALLOWED) expect(entry.reason.length).toBeGreaterThan(40);
});
