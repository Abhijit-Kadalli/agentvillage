#!/usr/bin/env bun
/**
 * B-167N LIVE PROTOCOL (P7): compare the hook decision lines read on the
 * canary box with expected.json, mechanically.
 *
 * Before a tag that adds a capability, Carter's canary box runs the CANDIDATE
 * tag (onebox to the candidate first, never the fleet tag), and each new
 * capability runs once end to end. review-a reads the hook's decision for each
 * call and writes one line per call in the pinned format
 *
 *   class | decision | card_style | core version | tool/command key
 *
 * - class: the class the hook (or the daemon propose) named;
 * - decision: auto | sampled | card | human-only | refused;
 * - card_style: minimal | technical | none (no card);
 * - core version: the approval.md core the box runs (it must be the candidate's);
 * - key: the recipe's command, the envelope key (`village#forkicks.order.confirm`),
 *   or a propose's action key (`marketplace.app.action:forkicks.order.confirm:<draftId>`;
 *   the draft id is the live one, so a propose key is matched up to its last colon).
 *
 * Usage: bun scripts/approval-class-diff/live-compare.ts --lines <file> --core <version>
 *          [--expected <path>] [--require <key>]...
 * Exit: 0 every line matches its entry (and every --require key has a line),
 *       1 a mismatch, an unknown key, a wrong core or a missing required line,
 *       2 usage or an unreadable input.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Layer = { class: string; decision: string; card_style?: string | null };
type Entry = Layer & { file?: string; command?: string; tool?: string; input?: Record<string, unknown>; propose?: Layer & { key: string } };

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

/** approval.md's envelopeKey (scripts/overlay-recipes-box.mjs), the same rule. */
export function envelopeKey(tool: string, input: Record<string, unknown> = {}): string {
  let key = tool;
  if (typeof input.operation === "string") key += `#${input.operation}`;
  if (typeof input.appId === "string") key += `:${input.appId}`;
  if (typeof input.tool === "string") key += `.${input.tool}`;
  return key;
}

const proposeStem = (key: string): string => key.slice(0, key.lastIndexOf(":") + 1);

export interface LineResult {
  line: string;
  key: string;
  ok: boolean;
  why: string[];
}

/** Compare parsed lines with the entries. Pure. */
export function compare(entries: Entry[], text: string, core: string): LineResult[] {
  const out: LineResult[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length !== 5) {
      out.push({ line, key: "", ok: false, why: ["not the pinned 5-field format: class | decision | card_style | core version | tool/command key"] });
      continue;
    }
    const [cls, decision, style, version, key] = parts as [string, string, string, string, string];
    const why: string[] = [];
    if (version !== core) why.push(`core ${version}, not the candidate's ${core} (the canary must run the candidate tag)`);
    let layer: Layer | undefined;
    for (const e of entries) {
      if (e.command !== undefined && norm(e.command) === norm(key)) layer = e;
      else if (e.tool !== undefined && envelopeKey(e.tool, e.input) === key) layer = e;
      else if (e.propose !== undefined && proposeStem(e.propose.key) !== "" && key.startsWith(proposeStem(e.propose.key)) && key.length > proposeStem(e.propose.key).length) layer = e.propose;
      if (layer !== undefined) break;
    }
    if (layer === undefined) {
      out.push({ line, key, ok: false, why: [...why, "no expected.json entry has this key (an undeclared call is a block)"] });
      continue;
    }
    if (cls !== layer.class) why.push(`class ${cls}, declared ${layer.class}`);
    const deny = layer.decision === "deny" && (decision === "human-only" || decision === "refused");
    if (decision !== layer.decision && !deny) why.push(`decision ${decision}, declared ${layer.decision}`);
    const carded = decision === "card" || decision === "sampled";
    if (carded && style !== "minimal") why.push(`card ${style}, not minimal`);
    if (!carded && style !== "none") why.push(`card_style ${style} on a call that showed no card`);
    out.push({ line, key, ok: why.length === 0, why });
  }
  return out;
}

function main(): void {
  const args = process.argv.slice(2);
  const val = (name: string): string | undefined => {
    const at = args.indexOf(name);
    return at === -1 ? undefined : args[at + 1];
  };
  const linesPath = val("--lines");
  const core = val("--core");
  if (linesPath === undefined || core === undefined) {
    process.stderr.write("usage: bun scripts/approval-class-diff/live-compare.ts --lines <file> --core <version> [--expected <path>] [--require <key>]...\n");
    process.exit(2);
  }
  let entries: Entry[];
  let text: string;
  try {
    entries = (JSON.parse(readFileSync(val("--expected") ?? join(import.meta.dir, "expected.json"), "utf8")) as { entries: Entry[] }).entries;
    text = readFileSync(linesPath, "utf8");
  } catch (error) {
    process.stderr.write(`live-compare: ${String(error)}\n`);
    process.exit(2);
  }
  const results = compare(entries, text, core);
  const required = args.flatMap((a, i) => (a === "--require" && args[i + 1] !== undefined ? [args[i + 1]!] : []));
  let bad = results.some((r) => !r.ok);
  for (const r of results) process.stdout.write(`${r.ok ? "MATCH " : "BLOCK "} ${r.line}${r.ok ? "" : `\n        ${r.why.join("; ")}`}\n`);
  for (const k of required) {
    if (!results.some((r) => r.key === k)) {
      bad = true;
      process.stdout.write(`BLOCK  (no live line) ${k}: the canary did not run this new capability\n`);
    }
  }
  process.stdout.write(`live-compare: ${String(results.filter((r) => r.ok).length)} of ${String(results.length)} line(s) match expected.json at core ${core}\n`);
  process.exit(bad ? 1 : 0);
}

if (import.meta.main) main();
