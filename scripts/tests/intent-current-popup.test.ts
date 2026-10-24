/**
 * V1-LEAK (B): every prompt that files an Index intent says an intent is for THIS popup.
 *
 * A resident's agent filed an intent whose content was a preference from an earlier popup. The fix is a
 * short positive rule in every prompt path that files an intent: an intent is what the resident wants now,
 * at Edge City India (its place and dates), from what they said in this popup's conversations or their
 * current profile; never a plan, place or preference carried over from an earlier popup, older memory or an
 * earlier year; when unsure, ask (in conversation) or drop it (a background pass, which cannot ask).
 *
 * The rule never names an earlier popup or its town: naming one plants it (lanes-context BUG-esmeralda).
 * This file names none either; the capitalised-word check below is how it keeps the rule free of names.
 *
 * Pinned here:
 *   - each filing prompt (FILING) carries the three phrases, the conversational ones the ask, the
 *     background one the drop;
 *   - discovery: every Markdown file the agent reads under skills/ and workspace/ that names an intent
 *     filing tool is either in FILING or in NOT_FILING with its reason, so a new filing prompt fails here
 *     until it carries the rule;
 *   - every Index cron spec (and job template) whose prompt names an intent filing tool is in FILING;
 *   - the rule's sentences name no place or popup but Edge City India, Mandrem and Goa.
 * The record_intention tool description (plugins/av-events/_record_intention.py CURRENT_POPUP_RULE) is
 * pinned word for word in plugins/av-events/tests/test_intention_source.py.
 *
 *   bun test scripts/tests/intent-current-popup.test.ts
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { DIGEST_CRON_SPECS, templateCronSpec } from "../../install/install_index";
import { RETIRED_SKILL_DIRS } from "../../install/paths";
import { TEMPLATE_NAMES } from "../../skills/index-network/scripts/job-settings";

const REPO = join(import.meta.dir, "..", "..");

/** The popup, word for word. */
export const POPUP = "Edge City India (Mandrem, Goa, October 11 to November 1, 2026)";
/** Never carry anything over, word for word (case-insensitive: a sentence may open with it). */
export const CARRY = "never carry over a plan, place or preference from an earlier popup, older memory or an earlier year";
/** Where the want comes from. */
export const FROM = "this popup's conversations";
/** In conversation: ask when unsure. */
export const ASK = "if you are not sure it is current, ask them before you record it";
/** In a background pass: drop when unsure. */
export const DROP = "if you are not sure it is current, drop it";

type Kind = "chat" | "background";

/** Every prompt path that files an intent, by repo path. */
const FILING: Array<{ path: string; kind: Kind; why: string }> = [
  { path: "skills/index-network/tools.md", kind: "chat", why: "Capturing new signal: create_intent / record_intention in chat" },
  { path: "skills/record-intention/SKILL.md", kind: "chat", why: "the record_intention skill (chat, onboarding, background)" },
  { path: "workspace/SOUL.md", kind: "chat", why: "the persona's create_intent / record_intention bullet, every session" },
  { path: "skills/index-network/prompts/memory-signals.md", kind: "background", why: "the 01:00 memory signal sync cron (DATA-361/470)" },
];

/** Files that name an intent filing tool without being a filing prompt, each with its reason. */
const NOT_FILING: Record<string, string> = {
  "workspace/AGENTS.md":
    "FROZEN (Carter edits it): its Intentions bullet and REFUSED_SEEDS line file intents; the proposed diff is in the V1-LEAK (B) report",
  "skills/approval/templates/APPROVAL.md": "a routing table the approval daemon reads, not a prompt",
  "skills/approval/README.md": "describes that routing table for humans",
  "skills/README.md": "the skills index for humans",
};

/** A filing tool named in prose or code. */
const FILING_TOOL = /create_intent|record_intention|update_intent/;

function flat(text: string): string {
  return text.replace(/`/g, "").replace(/\s+/g, " ").trim();
}

function read(path: string): string {
  return readFileSync(join(REPO, path), "utf8");
}

/** Every Markdown file under `dir` (repo-relative), the synced references and retired skills excluded. */
function markdown(dir: string): string[] {
  const out: string[] = [];
  const walk = (abs: string) => {
    for (const name of readdirSync(abs)) {
      if (name === "node_modules" || name === "tests") continue;
      const child = join(abs, name);
      const rel = relative(REPO, child);
      if (rel.split("/").includes("references")) continue;
      if (RETIRED_SKILL_DIRS.some((d) => rel === `skills/${d}` || rel.startsWith(`skills/${d}/`))) continue;
      if (statSync(child).isDirectory()) walk(child);
      else if (name.endsWith(".md")) out.push(rel);
    }
  };
  if (existsSync(join(REPO, dir))) walk(join(REPO, dir));
  return out.sort();
}

/** The rule's sentences in `text` (flattened): from the sentence that opens it to the end of the ask or drop. */
function ruleSpan(text: string, kind: Kind): string {
  const body = flat(text);
  const lower = body.toLowerCase();
  const end = lower.indexOf(kind === "chat" ? ASK : DROP);
  const at = lower.indexOf("this popup");
  if (end < 0 || at < 0) return "";
  // Back to the start of the sentence that first names this popup, then forward past the ask or drop.
  const openers = [". ", ": ", "\n", "- "].map((m) => body.lastIndexOf(m, at)).filter((i) => i >= 0);
  const start = openers.length ? Math.max(...openers) + 2 : 0;
  const stop = end + (kind === "chat" ? ASK : DROP).length;
  return stop > start ? body.slice(start, stop) : "";
}

describe("V1-LEAK (B): every intent-filing prompt says an intent is for this popup", () => {
  for (const { path, kind, why } of FILING) {
    test(`${path} (${why}) carries the rule`, () => {
      const text = flat(read(path));
      const lower = text.toLowerCase();
      expect({ path, popup: text.includes(POPUP) }).toEqual({ path, popup: true });
      expect({ path, carry: lower.includes(CARRY) }).toEqual({ path, carry: true });
      expect({ path, from: lower.includes(FROM) }).toEqual({ path, from: true });
      const tail = kind === "chat" ? ASK : DROP;
      expect({ path, tail: lower.includes(tail) }).toEqual({ path, tail: true });
      // A background pass never messages the resident: it drops, it never asks.
      if (kind === "background") expect(lower).not.toContain(ASK);
      // Once per file: a second copy is drift waiting to happen.
      expect({ path, copies: lower.split(CARRY).length - 1 }).toEqual({ path, copies: 1 });
    });
  }

  test("the rule names no place or popup but Edge City India, Mandrem and Goa", () => {
    // Capitalised words the rule's sentences may hold. Anything else (a town, another popup) fails here.
    const allowed = new Set(["A", "An", "Edge", "City", "India", "Mandrem", "Goa", "October", "November", "Never", "If", "Either", "It"]);
    for (const { path, kind } of FILING) {
      const span = ruleSpan(read(path), kind);
      expect({ path, found: span.length > 0 }).toEqual({ path, found: true });
      const caps = [...span.matchAll(/\b[A-Z][A-Za-z]*\b/g)].map((m) => m[0]).filter((w) => !allowed.has(w));
      expect({ path, caps }).toEqual({ path, caps: [] });
    }
  });

  test("discovery: every Markdown prompt naming a filing tool is a filing prompt or listed with its reason", () => {
    const filing = new Set(FILING.map((f) => f.path));
    const unlisted: string[] = [];
    const seen = new Set<string>();
    for (const path of [...markdown("skills"), ...markdown("workspace"), ...markdown("mini-apps")]) {
      if (!FILING_TOOL.test(read(path))) continue;
      seen.add(path);
      if (!filing.has(path) && !(path in NOT_FILING)) unlisted.push(path);
    }
    expect(unlisted).toEqual([]);
    // No stale entries: each listed file exists and still names a filing tool.
    for (const path of [...filing, ...Object.keys(NOT_FILING)]) expect({ path, seen: seen.has(path) }).toEqual({ path, seen: true });
  });

  test("every Index cron (and job template) whose prompt names a filing tool is a filing prompt", () => {
    const filing = new Set(FILING.map((f) => f.path));
    const specs = [...DIGEST_CRON_SPECS, ...TEMPLATE_NAMES.map((t) => templateCronSpec(t, "0 9 * * *"))];
    const filers: string[] = [];
    for (const spec of specs) {
      const body = spec.promptFile ? read(join("skills", spec.promptFile)) : (spec.promptBody ?? "");
      if (!FILING_TOOL.test(body)) continue;
      const path = spec.promptFile ? `skills/${spec.promptFile}` : `${spec.name} (inline promptBody)`;
      filers.push(path);
      expect({ path, filing: filing.has(path) }).toEqual({ path, filing: true });
    }
    // Today exactly one cron files intents: the nightly memory signal sync.
    expect([...new Set(filers)]).toEqual(["skills/index-network/prompts/memory-signals.md"]);
  });
});
