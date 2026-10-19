#!/usr/bin/env bun
/**
 * Mini-apps PR review, the deterministic half ("bot v0"): MINIAPPS-PLATFORM-v2-design.md §5 (lanes and
 * their rules), §6.1 (the checks), §6.3 (the output), §6.4 and §8 Phase 0 item 3. jmill's LLM half
 * (§6.2) reads this JSON and posts the PR comment later; this script posts nothing.
 *
 *   bun scripts/mini-apps-review.ts --base <rev> --head <rev> [--author <login>] [--repo <dir>]
 *       [--out <file.json>] [--summary <file.md>]
 *
 * It reads `git diff --raw --no-renames base...head` (the --name-status list plus the file modes), the
 * files at the merge base and at head, and judges the pull request:
 *   lane     changed files ⊆ mini-apps/<id>/** ∪ skills/<id>/** for exactly one id that has a manifest at
 *            head is a manifest lane, and the lane is that manifest's visibility (sandbox | admins |
 *            everyone; v1's `restricted` is sandbox or admins, as v1Entry serves them). Anything else is
 *            `core`. So is a pull request that turns a needs-card op into a read or write.
 *   checks   paths, author, schema (the ONE validator, scripts/mini-apps-manifests.cjs, loaded only when
 *            its bytes and the schema's hash to mini-apps/manifests.pins.json), hashes, version_bump,
 *            secrets, data_context, approval_classes, conformance, lane_rules (§5).
 *   verdict  any M finding: FAIL. Else core, or a §5 rule that needs the human read: NEEDS_HUMAN. Else any
 *            S finding: PASS in sandbox, NEEDS_HUMAN in admins and everyone. Else PASS. N is a note.
 *
 * The §6.3 JSON goes to stdout (and --out); a short summary goes to stderr (and --summary, markdown for
 * the job summary). Phase 0 is advisory and not a required check, so every verdict exits 0. Exit 2 means
 * the bot itself could not judge (bad arguments, git failed, the validator is not the pinned one): it
 * fails closed, still prints a FAIL report with code bot_error, and never prints PASS.
 *
 * Known limit (design §6.4): on pull_request, GitHub runs this workflow, this script and the validator
 * from the pull request's own checkout, so a pull request can edit its own gate. A pull request that
 * touches any of them is classed core here (GATE_FILES); the real gate is the cp's own copy of the
 * validator plus branch protection on the catalog repo later.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runInThisContext } from "node:vm";

export const BOT = "av-miniapp-review";
export const BOT_VERSION = "0.1";
export const REPO_ROOT = resolve(import.meta.dir, "..");
export const VALIDATOR_PATH = "scripts/mini-apps-manifests.cjs";
export const SCHEMA_PATH = "mini-apps/manifest.v2.schema.json";
export const PINS_PATH = "mini-apps/manifests.pins.json";
export const CATALOG_PATH = "mini-apps/catalog.json";
/** The review gate itself: a pull request that changes one of these is core, and says so. */
export const GATE_FILES = Object.freeze([
  "scripts/mini-apps-review.ts", "scripts/tests/mini-apps-review.test.ts", VALIDATOR_PATH, SCHEMA_PATH, PINS_PATH,
  CATALOG_PATH, "scripts/tests/mini-app-manifests.test.ts", ".github/workflows/mini-apps-review.yml",
]);
export const CHECKED = Object.freeze(["paths", "author", "schema", "hashes", "version_bump", "secrets", "data_context",
  "approval_classes", "conformance", "lane_rules"]);
export const VISIBILITY = Object.freeze(["sandbox", "admins", "everyone"]);
export const CEILINGS = Object.freeze(["private", "village", "public"]);
/** The widest data.context ceiling each lane may declare without the human lane (design §1.3, §7). */
export const LANE_CEILING: Readonly<Record<string, string>> = Object.freeze({ sandbox: "public", admins: "public", everyone: "village" });
/** The §5 rules: a finding with one of these codes needs the human read in every lane. */
export const HUMAN_CODES = Object.freeze(new Set(["core_path", "gate_changed", "manifest_deleted", "no_manifest", "needs_card_downgrade",
  "needs_card_replaced", "needs_card_review", "oauth_review", "context_ceiling_above_private", "events_review",
  "events_entering_everyone", "visibility_raise_multi_step", "visibility_raise_with_major", "author_not_owner"]));
/** The files a manifest lane may hold (P0-1's closed mini-apps/ tree, plus P0-5's conformance.json). */
const LANE_FILES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "mini-apps": ["manifest.json", "README.md", "conformance.json"], skills: ["SKILL.md"],
});
const APP_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REV = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._\/^~-]{0,199}$/;
const MAX_PER_CODE = 10;

export type Severity = "M" | "S" | "N";
export type Finding = { code: string; severity: Severity; file?: string; line?: number; text: string };
export type Lane = "sandbox" | "admins" | "everyone" | "core";
export type Verdict = "PASS" | "FAIL" | "NEEDS_HUMAN";
export type Report = {
  bot: string; version: string; manifest: string | null; head: string; verdict: Verdict; lane: Lane;
  findings: Finding[]; checked: string[];
};
export type Change = { status: string; path: string; oldMode: string; newMode: string };
export type Bytes = Buffer | null;
/** What a review reads. `review()` builds one from git; the tests build them by hand too. */
export type Source = {
  files: Change[];
  base: (path: string) => Bytes;
  head: (path: string) => Bytes;
  added: (path: string) => { line: number; text: string }[] | "binary";
  headSha: string;
  author: string;
};

/** The bot cannot judge: exit 2, fail closed. */
export class BotError extends Error {}

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const isObject = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);
/** Key-sorted JSON, so two manifests compare by content, not by key order. */
export function canon(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canon(value[k])}`).join(",")}}`;
  return value === undefined ? "null" : JSON.stringify(value);
}

// ---- The validator: P0-1's one module, loaded only at its pinned bytes -----------------------------
export type Validator = {
  validateManifest: (value: unknown) => { ok: boolean; errors?: { path: string; reason: string }[] };
  buildCatalog: (index: unknown, byId: Record<string, unknown>) => { ok: boolean; dropped?: { id: string; code: string; errors: { path: string; reason: string }[] }[]; errors?: unknown[] };
  operationBudgets: (op: unknown) => Record<string, number | string>;
};
/**
 * Read the validator and the schema from `root`, refuse unless both hash to manifests.pins.json, and run
 * exactly the bytes that were hashed (never a second read through require). Any mismatch: BotError.
 */
export function loadValidator(root = REPO_ROOT): Validator {
  const read = (rel: string) => {
    try { return readFileSync(join(root, rel)); } catch { throw new BotError(`validator_unreadable: ${rel}`); }
  };
  let pins: any;
  try { pins = JSON.parse(read(PINS_PATH).toString("utf8")); } catch (e) {
    if (e instanceof BotError) throw e;
    throw new BotError(`validator_pins_unparseable: ${PINS_PATH}`);
  }
  const source = read(VALIDATOR_PATH), schema = read(SCHEMA_PATH);
  const want = isObject(pins?.sha256) ? pins.sha256 : {};
  if (typeof want.module !== "string" || sha256(source) !== want.module) {
    throw new BotError(`validator_pin_mismatch: ${VALIDATOR_PATH} is ${sha256(source)}, ${PINS_PATH} pins ${String(want.module)}`);
  }
  if (typeof want.schema !== "string" || sha256(schema) !== want.schema) {
    throw new BotError(`validator_pin_mismatch: ${SCHEMA_PATH} is ${sha256(schema)}, ${PINS_PATH} pins ${String(want.schema)}`);
  }
  const module = { exports: {} as any };
  try {
    const wrapped = runInThisContext(`(function (exports, require, module) {${source.toString("utf8")}\n})`, { filename: join(root, VALIDATOR_PATH) });
    wrapped(module.exports, (name: string) => { throw new Error(`the validator is dependency-free; it asked for ${name}`); }, module);
  } catch (e) {
    throw new BotError(`validator_load_failed: ${(e as Error).message}`);
  }
  const v = module.exports;
  for (const name of ["validateManifest", "buildCatalog", "operationBudgets"]) {
    if (typeof v[name] !== "function") throw new BotError(`validator_shape: no ${name}`);
  }
  if (JSON.stringify(v.SCHEMA, null, 2) + "\n" !== schema.toString("utf8")) throw new BotError("validator_shape: SCHEMA is not the schema file");
  return v as Validator;
}

// ---- Git -----------------------------------------------------------------------------------------
function git(repo: string, args: string[], allowFail = false): Buffer | null {
  const r = spawnSync("git", ["-C", repo, "-c", "core.quotePath=false", ...args], { maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new BotError(`git_unavailable: ${r.error.message}`);
  if (r.status !== 0) {
    if (allowFail) return null;
    throw new BotError(`git_failed: git ${args[0]}: ${String(r.stderr).split("\n")[0].slice(0, 200)}`);
  }
  return r.stdout as Buffer;
}
/** `git diff --raw --no-renames -z base...head`: status, path and both modes of every changed file. */
export function changedFiles(repo: string, base: string, head: string): Change[] {
  const out = git(repo, ["diff", "--raw", "--no-renames", "--no-abbrev", "--no-ext-diff", "--no-textconv", "-z", `${base}...${head}`])!;
  const parts = out.toString("utf8").split("\0");
  const files: Change[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/.exec(parts[i]);
    if (!meta) throw new BotError(`git_diff_unparseable: ${parts[i].slice(0, 80)}`);
    files.push({ oldMode: meta[1], newMode: meta[2], status: meta[3], path: parts[i + 1] });
  }
  return files;
}
/** The lines `head` adds to one file since the merge base, with their head line numbers. */
export function addedLines(repo: string, base: string, head: string, path: string): { line: number; text: string }[] | "binary" {
  const out = git(repo, ["--literal-pathspecs", "diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", `${base}...${head}`, "--", path])!;
  const lines = out.toString("utf8").split("\n");
  const added: { line: number; text: string }[] = [];
  let n = 0, inHunk = false;
  for (const l of lines) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (hunk) { n = Number(hunk[1]); inHunk = true; continue; }
    if (!inHunk) { if (/^Binary files .* differ$/.test(l)) return "binary"; continue; }
    if (l.startsWith("+")) added.push({ line: n++, text: l.slice(1) });
    else if (l.startsWith(" ")) n++;
  }
  return added;
}
function blobAt(repo: string, rev: string, path: string): Bytes {
  const type = git(repo, ["cat-file", "-t", `${rev}:${path}`], true);
  if (!type || type.toString("utf8").trim() !== "blob") return null;
  return git(repo, ["cat-file", "blob", `${rev}:${path}`]);
}
/** A Source from a real repository: everything base-side is read at the merge base, as the diff is. */
export function gitSource(repo: string, base: string, head: string, author: string): Source {
  for (const rev of [base, head]) if (!REV.test(rev)) throw new BotError(`bad_revision: ${JSON.stringify(rev).slice(0, 80)}`);
  const headSha = git(repo, ["rev-parse", "--verify", `${head}^{commit}`])!.toString("utf8").trim();
  git(repo, ["rev-parse", "--verify", `${base}^{commit}`]);
  const mergeBase = git(repo, ["merge-base", base, head])!.toString("utf8").trim();
  return {
    files: changedFiles(repo, base, head),
    base: path => blobAt(repo, mergeBase, path),
    head: path => blobAt(repo, headSha, path),
    added: path => addedLines(repo, base, head, path),
    headSha,
    author,
  };
}

// ---- Paths: the lane classifier --------------------------------------------------------------------
const LANE_PATH = /^(mini-apps|skills)\/([^/]+)\/(.+)$/;
/** The one app id the pull request stays inside, or null (core) with why. */
export function classify(files: Change[]): { id: string | null; core: string[] } {
  const ids = new Set<string>(), core: string[] = [];
  for (const f of files) {
    const m = LANE_PATH.exec(f.path);
    if (!m || !APP_ID.test(m[2])) core.push(f.path);
    else ids.add(m[2]);
  }
  if (files.length === 0) return { id: null, core: ["(no changed files)"] };
  if (ids.size !== 1) return { id: null, core: [...core, ...(ids.size > 1 ? [`${ids.size} app ids: ${[...ids].sort().join(", ")}`] : [])] };
  return { id: core.length ? null : [...ids][0], core };
}

// ---- Secrets: gitleaks-style shapes over the added lines --------------------------------------------
/** Each names a credential shape; a hit is reported by name and line, never by value. */
export const SECRET_PATTERNS: readonly (readonly [string, RegExp])[] = Object.freeze([
  ["openai_or_anthropic_key", /\bsk-(?:proj-|ant-[a-z0-9]*-)?[A-Za-z0-9_-]{16,}/],
  ["stripe_key", /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/],
  ["github_token", /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}/],
  ["github_pat", /\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/],
  ["pem_private_key", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/],
  ["aws_access_key_id", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["aws_secret_access_key", /\baws_?secret_?access_?key\b["']?\s*[:=]\s*["']?[A-Za-z0-9\/+]{40}\b/i],
  ["slack_token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ["google_api_key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["password_assignment", /\bpass(?:word|wd)\s*=\s*["']?[^\s"'`]{3,}/i],
  ["password_field", /["']pass(?:word|wd)["']\s*:\s*["'][^"']{3,}["']/i],
  ["bearer_token", /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}=*/],
  // The value must hold a letter and a digit: a plain identifier or an upper-case variable name is not a credential.
  ["credential_assignment", /\b(?:api[_-]?key|secret|token|access[_-]?key|client[_-]?secret)\b["']?\s*[:=]\s*["'](?=[^"'\s]*\d)(?=[^"'\s]*[A-Za-z])[A-Za-z0-9_\-+\/=.]{16,}["']/i],
]);
const DATA_URI = /\bdata:[a-z]+\/[a-z0-9.+-]+[;,]/i;
const BASE64_RUN = /[A-Za-z0-9+\/_-]{1025,}={0,2}/;
export function secretHits(text: string): string[] {
  return SECRET_PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

// ---- Version bump class ---------------------------------------------------------------------------
export const LEVELS = Object.freeze(["none", "patch", "minor", "major"] as const);
export type Level = (typeof LEVELS)[number];
const rank = (l: Level) => LEVELS.indexOf(l);
const ops = (m: any): any[] => (Array.isArray(m?.operations) ? m.operations.filter(isObject) : []);
const byName = (m: any) => new Map(ops(m).filter(op => typeof op.name === "string").map(op => [op.name as string, op]));
const ceilingRank = (m: any) => (isObject(m?.data?.context) ? Math.max(0, CEILINGS.indexOf(m.data.context.ceiling ?? "private")) : -1);
/**
 * The smallest version bump the change from `base` to `head` needs (design §1.1 `version`): major for an
 * added op, a class/target/input/service/auth/approval change, a raised budget, added or widened data or
 * events, a new permission; minor for a narrowing or a visibility change; patch for copy and skill bytes.
 * An input schema change counts as major: whether it only tightens cannot be told from the diff.
 */
export function requiredBump(base: any, head: any, budgets: Validator["operationBudgets"]): { level: Level; reasons: string[] } {
  const found: [Level, string][] = [];
  const need = (level: Level, why: string) => found.push([level, why]);
  if (canon(base) === canon(head)) return { level: "none", reasons: [] };
  const bo = byName(base), ho = byName(head);
  for (const [name, op] of ho) {
    const b = bo.get(name);
    if (!b) { need("major", `operation ${name} added`); continue; }
    if (b.class !== op.class) need("major", `${name} class ${b.class} -> ${op.class}`);
    if (canon(b.target) !== canon(op.target)) need("major", `${name} target changed`);
    if (canon(b.input) !== canon(op.input)) need("major", `${name} input schema changed`);
    const bb = budgets(b), hb = budgets(op);
    for (const k of ["maxRequestBytes", "maxResponseBytes", "timeoutMs"]) {
      if (Number(hb[k]) > Number(bb[k])) need("major", `${name} ${k} raised ${bb[k]} -> ${hb[k]}`);
      else if (Number(hb[k]) < Number(bb[k])) need("minor", `${name} ${k} lowered`);
    }
    if (bb.framing !== hb.framing) need("major", `${name} framing ${bb.framing} -> ${hb.framing}`);
    if (canon(b.returns) !== canon(op.returns)) {
      const br = b.returns, hr = op.returns;
      const widened = !isObject(br) || !isObject(hr) || br.draftIdPath !== hr.draftIdPath || br.previewPath !== hr.previewPath ||
        Number(hr.previewMaxBytes) > Number(br.previewMaxBytes) || Number(hr.previewTtlSeconds) > Number(br.previewTtlSeconds);
      need(widened ? "major" : "minor", `${name} returns ${widened ? "changed" : "narrowed"}`);
    }
    if (canon(b.approval) !== canon(op.approval)) need("major", `${name} approval (prepare or summary) changed`);
  }
  for (const name of bo.keys()) if (!ho.has(name)) need("minor", `operation ${name} removed`);
  if (canon(base?.service) !== canon(head?.service)) need("major", "service (kind, baseUrl or auth) changed");
  if (canon(base?.data) !== canon(head?.data)) {
    const bc = base?.data?.context, hc = head?.data?.context;
    const otherKeys = (d: any) => canon(isObject(d) ? Object.fromEntries(Object.entries(d).filter(([k]) => k !== "context")) : {});
    if (otherKeys(base?.data) !== otherKeys(head?.data)) need("major", "a data block other than data.context changed");
    if (!isObject(bc) && isObject(hc)) need("major", "data.context added");
    else if (isObject(bc) && !isObject(hc)) need("minor", "data.context removed");
    else if (isObject(bc) && isObject(hc)) {
      if (Number(hc.maxEntries) > Number(bc.maxEntries)) need("major", "data.context.maxEntries raised");
      else if (Number(hc.maxEntries) < Number(bc.maxEntries)) need("minor", "data.context.maxEntries lowered");
      const br = ceilingRank(base), hr = ceilingRank(head);
      if (hr > br) need("major", "data.context.ceiling raised");
      else if (hr < br) need("minor", "data.context.ceiling lowered");
    }
  }
  if (canon(base?.events) !== canon(head?.events)) {
    const be = isObject(base?.events) ? base.events : {}, he = isObject(head?.events) ? head.events : {};
    const widened = Object.keys(he).some(k => canon(he[k]) !== canon(be[k]));
    need(widened ? "major" : "minor", `events ${widened ? "added or changed" : "removed"}`);
  }
  if (canon(base?.permissions) !== canon(head?.permissions)) {
    const list = (m: any) => (Array.isArray(m?.permissions) ? m.permissions : []);
    const actions = (m: any) => list(m).filter((p: any) => p?.kind === "action").length;
    const widened = list(head).length > list(base).length || actions(head) > actions(base);
    need(widened ? "major" : "minor", `permissions ${widened ? "added" : "reworded"}`);
  }
  if (canon(base?.legacy) !== canon(head?.legacy)) need("major", "legacy block changed");
  if (base?.visibility !== head?.visibility) need("minor", `visibility ${base?.visibility} -> ${head?.visibility}`);
  if (canon(base?.skills) !== canon(head?.skills)) need("patch", "skill bytes or version changed");
  for (const k of ["name", "description", "homepage", "owner", "credit", "manifest", "id"]) {
    if (canon(base?.[k]) !== canon(head?.[k])) need("patch", `${k} changed`);
  }
  if (!found.length) need("patch", "manifest changed");
  const level = found.reduce<Level>((top, [l]) => (rank(l) > rank(top) ? l : top), "none");
  return { level, reasons: found.filter(([l]) => l === level).map(([, why]) => why) };
}
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
/** The bump `from -> to` is (by the numeric triple), "down" for a decrease, or null if either is not semver. */
export function bumpOf(from: unknown, to: unknown): Level | "down" | null {
  const a = typeof from === "string" ? SEMVER.exec(from) : null, b = typeof to === "string" ? SEMVER.exec(to) : null;
  if (!a || !b) return null;
  for (const [i, level] of [[1, "major"], [2, "minor"], [3, "patch"]] as const) {
    if (Number(b[i]) > Number(a[i])) return level;
    if (Number(b[i]) < Number(a[i])) return "down";
  }
  return "none";
}

// ---- The verdict (§6.3) -------------------------------------------------------------------------------
export function verdictOf(lane: Lane, findings: Finding[]): Verdict {
  if (findings.some(f => f.severity === "M")) return "FAIL";
  if (lane === "core") return "NEEDS_HUMAN";
  if (findings.some(f => f.severity !== "N" && HUMAN_CODES.has(f.code))) return "NEEDS_HUMAN";
  if (findings.some(f => f.severity === "S")) return lane === "sandbox" ? "PASS" : "NEEDS_HUMAN";
  return "PASS";
}

// ---- The review -----------------------------------------------------------------------------------------
const parseJson = (bytes: Bytes): { ok: true; value: any } | { ok: false } => {
  if (!bytes) return { ok: false };
  try { return { ok: true, value: JSON.parse(bytes.toString("utf8")) }; } catch { return { ok: false }; }
};
const ownerLogins = (m: any): string[] | null => {
  const g = m?.owner?.github;
  const list = typeof g === "string" ? [g] : Array.isArray(g) ? g.filter(x => typeof x === "string") : [];
  return list.length ? list : null;
};

/** Judge one pull request. Pure over `src` and `validator`; throws BotError only for a broken input. */
export function evaluate(src: Source, validator: Validator): Report {
  const findings: Finding[] = [];
  const counts = new Map<string, number>();
  const add = (f: Finding) => {
    const n = (counts.get(f.code) ?? 0) + 1;
    counts.set(f.code, n);
    if (n <= MAX_PER_CODE) findings.push(f);
    else if (n === MAX_PER_CODE + 1) findings.push({ code: f.code, severity: f.severity, text: `more ${f.code} findings not listed` });
  };

  // paths
  const { id, core } = classify(src.files);
  let lane: Lane = "core";
  for (const path of core) {
    const why = path.startsWith("(") || / app ids: /.test(path) ? `${path.replace(/^\((.*)\)$/, "$1")}: a manifest lane is exactly one app id` : `${path} is outside one app's mini-apps/<id>/ and skills/<id>/`;
    add({ code: "core_path", severity: "S", file: path.startsWith("(") || / app ids: /.test(path) ? undefined : path, text: `${why}: core, the human gate` });
  }
  for (const f of src.files) {
    if (GATE_FILES.includes(f.path)) add({ code: "gate_changed", severity: "S", file: f.path, text: "this pull request changes the review gate itself (script, validator, pins, catalog index or workflow); its own result is advisory only" });
    if (f.newMode === "120000" || f.newMode === "160000") add({ code: "path_symlink", severity: "M", file: f.path, text: `${f.newMode === "120000" ? "a symlink" : "a submodule"} is never a reviewed catalog file` });
    const m = LANE_PATH.exec(f.path);
    if (m && f.status !== "D" && !(LANE_FILES[m[1]] ?? []).includes(m[3])) {
      add({ code: "path_unknown_file", severity: "M", file: f.path, text: `only ${LANE_FILES[m[1]].join(", ")} may sit in ${m[1]}/<id>/ (no code, no other files)` });
    }
  }
  const manifestPath = id ? `mini-apps/${id}/manifest.json` : null;
  const headBytes = manifestPath ? src.head(manifestPath) : null;
  const baseBytes = manifestPath ? src.base(manifestPath) : null;
  if (id && !headBytes) add({ code: baseBytes ? "manifest_deleted" : "no_manifest", severity: "S", file: manifestPath!, text: baseBytes ? "the pull request removes this app's manifest: unpublishing is core" : `${id} has no manifest at head: skills/${id}/ is a baseline skill or a new app without one, core` });
  const laneId = id && headBytes ? id : null;

  // Everything below reads one manifest: the lane's.
  const head = laneId ? parseJson(headBytes) : { ok: false as const };
  const baseParsed = laneId && baseBytes ? parseJson(baseBytes) : { ok: false as const };
  const hm: any = head.ok ? head.value : null;
  const bm: any = baseParsed.ok ? baseParsed.value : null;
  if (laneId && !head.ok) add({ code: "manifest_unparseable", severity: "M", file: manifestPath!, text: "the manifest is not JSON" });
  if (laneId && baseBytes && !baseParsed.ok) add({ code: "base_unparseable", severity: "N", file: manifestPath!, text: "the base manifest is not JSON: the base comparisons are skipped" });
  if (laneId) lane = VISIBILITY.includes(hm?.visibility) ? hm.visibility : "core";

  // author: owner.github is not filled in any manifest yet (P0-1), so this never passes on its own.
  if (laneId) {
    const owners = ownerLogins(hm);
    if (!owners || !LOGIN.test(src.author)) add({ code: "author_unverified", severity: "N", file: manifestPath!, text: owners ? "the pull request author is missing or not a user login: not checked" : "the manifest names no owner.github yet: the author is not checked" });
    else if (owners.some(o => o.toLowerCase() === src.author.toLowerCase())) add({ code: "author_is_owner", severity: "N", file: manifestPath!, text: `${src.author} is a listed owner` });
    else add({ code: "author_not_owner", severity: "S", file: manifestPath!, text: `${src.author} is not in owner.github: the human read decides (staff may open it)` });
  }

  // schema: the one validator, and the catalog it builds.
  let schemaOk = false;
  if (laneId && head.ok) {
    const r = validator.validateManifest(hm);
    schemaOk = r.ok;
    for (const e of r.errors ?? []) add({ code: "schema_invalid", severity: "M", file: manifestPath!, text: `${e.path} ${e.reason}` });
    const index = parseJson(src.head(CATALOG_PATH));
    const listed = index.ok && Array.isArray(index.value?.apps) && index.value.apps.includes(laneId);
    if (!listed) add({ code: "catalog_unlisted", severity: "N", file: CATALOG_PATH, text: `${laneId} is not in mini-apps/catalog.json at head, so the cp does not serve it; listing it is a core change` });
    else if (schemaOk) {
      const byId: Record<string, unknown> = {};
      for (const other of index.value.apps) {
        if (typeof other !== "string") continue;
        const p = parseJson(src.head(`mini-apps/${other}/manifest.json`));
        byId[other] = p.ok ? p.value : new Error("unreadable");
      }
      const built = validator.buildCatalog(index.value, byId);
      const dropped = built.ok ? built.dropped?.find(d => d.id === laneId) : null;
      if (!built.ok) add({ code: "catalog_invalid", severity: "M", file: CATALOG_PATH, text: "mini-apps/catalog.json at head is not a valid index" });
      else if (dropped) add({ code: "catalog_dropped", severity: "M", file: manifestPath!, text: `the cp would drop ${laneId}: ${dropped.errors.map(e => `${e.path} ${e.reason}`).join("; ") || dropped.code}` });
    }
  }

  // hashes: each skill's sha256 and frontmatter version, at head.
  if (laneId && head.ok && Array.isArray(hm.skills)) {
    for (const skill of hm.skills.filter(isObject)) {
      if (typeof skill.path !== "string" || !/^skills\/[a-z][a-z0-9-]{0,63}\/SKILL\.md$/.test(skill.path)) continue;
      const bytes = src.head(skill.path);
      if (!bytes) { add({ code: "skill_missing", severity: "M", file: skill.path, text: "the manifest names a skill file that is not at head" }); continue; }
      if (sha256(bytes) !== skill.sha256) add({ code: "skill_hash_mismatch", severity: "M", file: skill.path, text: `skills[].sha256 is not the file's sha256 (${sha256(bytes).slice(0, 12)}…)` });
      const version = /^---\n(?:.*\n)*?version: (\S+)\n(?:.*\n)*?---\n/.exec(bytes.toString("utf8"))?.[1];
      if (version !== skill.version) add({ code: "skill_version_mismatch", severity: "M", file: skill.path, text: `skills[].version ${skill.version} is not the frontmatter version ${version ?? "(none)"}` });
    }
  }

  // version_bump: against the base manifest; a new manifest has no bump to check.
  let bump: { level: Level; reasons: string[] } = { level: "none", reasons: [] };
  let actual: Level | "down" | null = null;
  if (laneId && head.ok && bm) {
    bump = requiredBump(bm, hm, validator.operationBudgets);
    actual = bumpOf(bm.version, hm.version);
    if (actual === "down") add({ code: "version_not_monotonic", severity: "M", file: manifestPath!, text: `version ${bm.version} -> ${hm.version} goes down` });
    else if (actual !== null && rank(actual) < rank(bump.level)) {
      add({ code: actual === "none" ? "version_not_bumped" : "version_bump_too_small", severity: "M", file: manifestPath!,
        text: `version ${bm.version} -> ${hm.version} is ${actual}; the change needs ${bump.level}: ${bump.reasons.slice(0, 3).join("; ")}` });
    } else if (bump.level !== "none") add({ code: "version_bump", severity: "N", file: manifestPath!, text: `version ${bm.version} -> ${hm.version} (${actual}); the change needs ${bump.level}` });
  } else if (laneId && head.ok && !baseBytes) add({ code: "version_new_manifest", severity: "N", file: manifestPath!, text: "a new manifest: no bump to check" });

  // secrets: credential shapes on every added line of every file; data: URIs and big base64 in catalog files.
  for (const f of src.files) {
    if (f.status === "D") continue;
    const added = src.added(f.path);
    if (added === "binary") { add({ code: "binary_file", severity: "N", file: f.path, text: "a binary file: not scanned" }); continue; }
    for (const { line, text } of added) {
      for (const name of secretHits(text)) add({ code: "secret_in_diff", severity: "M", file: f.path, line, text: `an added line matches the ${name} shape (value not shown)` });
    }
    if (LANE_PATH.test(f.path)) {
      const body = src.head(f.path)?.toString("utf8") ?? "";
      const lineOf = (re: RegExp) => { const m = re.exec(body); return m ? body.slice(0, m.index).split("\n").length : undefined; };
      if (DATA_URI.test(body)) add({ code: "data_uri", severity: "M", file: f.path, line: lineOf(DATA_URI), text: "a data: URI in a catalog file" });
      if (BASE64_RUN.test(body)) add({ code: "base64_blob", severity: "M", file: f.path, line: lineOf(BASE64_RUN), text: "a base64-alphabet run over 1 KiB in a catalog file" });
    }
  }

  // data_context: maxEntries, the lane's ceiling, and no other data block.
  if (laneId && head.ok && hm.data !== undefined) {
    const data = hm.data;
    if (!isObject(data)) add({ code: "data_block_invalid", severity: "M", file: manifestPath!, text: "data is not an object" });
    else {
      for (const k of Object.keys(data)) if (k !== "context") add({ code: "data_block_not_allowed", severity: "M", file: manifestPath!, text: `data.${k}: only data.context is allowed (no other storage)` });
      const ctx = data.context;
      if (ctx !== undefined) {
        if (!isObject(ctx) || !Number.isInteger(ctx.maxEntries) || ctx.maxEntries < 1 || ctx.maxEntries > 64) add({ code: "context_max_entries", severity: "M", file: manifestPath!, text: "data.context.maxEntries must be an integer 1..64" });
        if (isObject(ctx) && ctx.ceiling === undefined) add({ code: "context_ceiling_missing", severity: "S", file: manifestPath!, text: "data.context declares no ceiling (read as private); declare it" });
        const ceiling = isObject(ctx) ? (ctx.ceiling ?? "private") : "private";
        if (lane !== "core" && CEILINGS.indexOf(ceiling) > CEILINGS.indexOf(LANE_CEILING[lane])) add({ code: "context_ceiling_over_lane", severity: "M", file: manifestPath!, text: `data.context.ceiling ${ceiling} is above the ${lane} lane's ${LANE_CEILING[lane]}` });
        if (ceilingRank(hm) > 0 && ceilingRank(hm) !== ceilingRank(bm)) add({ code: "context_ceiling_above_private", severity: "S", file: manifestPath!, text: `data.context.ceiling ${ceiling} is new in this pull request: above private needs the human read (§5)` });
      }
    }
  }

  // approval_classes: needs-card ↔ prepare; no downgrade; the template render is not run yet.
  if (laneId && head.ok) {
    const ho = byName(hm), bo = byName(bm);
    for (const op of ho.values()) {
      if (op.class !== "needs-card") continue;
      const prep = ho.get(op.approval?.prepare);
      if (!prep || prep.class !== "prepare") add({ code: "needs_card_without_prepare", severity: "M", file: manifestPath!, text: `${op.name} names no prepare op of class prepare` });
      if (!Array.isArray(op.approval?.summary)) add({ code: "approval_summary_missing", severity: "N", file: manifestPath!, text: `${op.name} has no approval.summary template: its card is still hand-coded (P0-1 decision 4)` });
      add({ code: "template_render_not_run", severity: "N", file: manifestPath!, text: `${op.name}: no §3.2 summary renderer exists in this repository yet, so the card template was not rendered (not a pass)` });
      const was = bo.get(op.name);
      if (!was || canon(was) !== canon(op)) add({ code: "needs_card_review", severity: "S", file: manifestPath!, text: `${op.name} is a needs-card op ${was ? "changed" : "added"} in this pull request: the human read (§5, §6.5)` });
    }
    let downgraded = false;
    for (const was of bo.values()) {
      if (was.class !== "needs-card") continue;
      const now = ho.get(was.name);
      if (now && now.class !== "needs-card") {
        downgraded = true;
        add({ code: "needs_card_downgrade", severity: "S", file: manifestPath!, text: `${was.name} was needs-card and is now ${now.class}: a downgrade is core` });
      }
    }
    const removedCard = [...bo.values()].some(op => op.class === "needs-card" && !ho.has(op.name));
    const newPlain = [...ho.values()].some(op => !bo.has(op.name) && op.class !== "needs-card");
    if (bm && removedCard && newPlain) add({ code: "needs_card_replaced", severity: "S", file: manifestPath!, text: "a needs-card op was removed and a new op without a card was added: the human read decides whether it is a renamed downgrade" });
    if (downgraded) lane = "core";
  }

  // conformance: conformance.json next to the manifest (P0-5 writes it; this only reads it).
  if (laneId && headBytes) {
    const path = `mini-apps/${laneId}/conformance.json`;
    const bytes = src.head(path);
    if (!bytes) add({ code: "conformance_missing", severity: "S", file: path, text: "no conformance.json next to the manifest (P0-5 builds the suite)" });
    else {
      const c = parseJson(bytes);
      if (!c.ok || !isObject(c.value)) add({ code: "conformance_unreadable", severity: "M", file: path, text: "conformance.json is not a JSON object" });
      else {
        if (c.value.passed !== true) add({ code: "conformance_failed", severity: "M", file: path, text: "conformance.json does not say passed: true" });
        if (c.value.sha256 !== sha256(headBytes)) add({ code: "conformance_stale", severity: "M", file: path, text: "conformance.json's sha256 is not this manifest's: it was run on another version" });
      }
    }
  }

  // lane_rules (§5): visibility one step at a time and never with a major bump; oauth and events read by a human.
  if (laneId && head.ok) {
    const from = bm ? VISIBILITY.indexOf(bm.visibility) : -1, to = VISIBILITY.indexOf(hm.visibility);
    if (to >= 0 && to - from > 1) add({ code: "visibility_raise_multi_step", severity: "S", file: manifestPath!, text: `visibility ${bm?.visibility ?? "(new)"} -> ${hm.visibility} is more than one step` });
    if (to >= 0 && to > from && from >= 0 && (bump.level === "major" || actual === "major")) add({ code: "visibility_raise_with_major", severity: "S", file: manifestPath!, text: `visibility raised to ${hm.visibility} in the same pull request as a major bump` });
    if (hm.service?.auth?.mode === "oauth" && canon(hm.service.auth) !== canon(bm?.service?.auth)) add({ code: "oauth_review", severity: "S", file: manifestPath!, text: "an oauth auth block is new or changed: the human read (a client registration and env vars)" });
    const events = isObject(hm.events) && Object.keys(hm.events).length > 0;
    const entering = hm.visibility === "everyone" && bm?.visibility !== "everyone";
    if (events && (canon(hm.events) !== canon(bm?.events) || entering)) {
      add({ code: hm.visibility === "everyone" ? "events_entering_everyone" : "events_review", severity: "S", file: manifestPath!, text: "an events block is new or changed, or enters the everyone lane: a data release is the data seat's read (§6.5)" });
    }
  }

  return {
    bot: BOT, version: BOT_VERSION, manifest: laneId && hm ? `${laneId}@${typeof hm.version === "string" ? hm.version : "?"}` : (id ?? null),
    head: src.headSha, verdict: verdictOf(lane, findings), lane, findings, checked: [...CHECKED],
  };
}

/** Review a real pull request. */
export function review(opts: { repo: string; base: string; head: string; author?: string; validatorRoot?: string }): Report {
  const validator = loadValidator(opts.validatorRoot ?? REPO_ROOT);
  return evaluate(gitSource(opts.repo, opts.base, opts.head, opts.author ?? ""), validator);
}

/** The fail-closed report: the bot could not judge, so it never says PASS. */
export function errorReport(message: string, head = ""): Report {
  return {
    bot: BOT, version: BOT_VERSION, manifest: null, head, verdict: "FAIL", lane: "core",
    findings: [{ code: "bot_error", severity: "M", text: message.slice(0, 500) }], checked: [],
  };
}

const cell = (s: unknown) => String(s ?? "").replace(/[|`\n\r]/g, " ").slice(0, 300);
export function summary(r: Report): string {
  const rows = r.findings.map(f => `| ${f.severity} | \`${cell(f.code)}\` | ${cell(f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "")} | ${cell(f.text)} |`);
  return [
    "### Mini-apps review (bot v0, deterministic, advisory)",
    "",
    `**${r.verdict}** · lane \`${r.lane}\` · ${r.manifest ? `\`${cell(r.manifest)}\`` : "no single manifest"} · head \`${r.head.slice(0, 12)}\``,
    "",
    ...(rows.length ? ["| sev | code | where | note |", "|---|---|---|---|", ...rows] : ["No findings."]),
    "",
    `Checked: ${r.checked.join(", ") || "nothing (the bot could not run)"}. M = FAIL; S = PASS in sandbox, NEEDS_HUMAN in admins/everyone; N = note. Phase 0: not a required check.`,
    "",
  ].join("\n");
}

function parseArgs(argv: string[]): Record<string, string> {
  const known = new Set(["--base", "--head", "--author", "--repo", "--out", "--summary"]);
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!known.has(argv[i]) || argv[i + 1] === undefined) throw new BotError(`usage: unknown or empty option ${JSON.stringify(argv[i]).slice(0, 40)}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  if (!out.base || !out.head) throw new BotError("usage: --base <rev> --head <rev> [--author <login>] [--repo <dir>] [--out <file>] [--summary <file>]");
  if (out.author && !LOGIN.test(out.author) && !/^[A-Za-z0-9-]{1,39}\[bot\]$/.test(out.author)) throw new BotError("usage: --author is not a GitHub login");
  return out;
}

/** The CLI. 0: reviewed (any verdict). 2: the bot is broken; a FAIL report is still written. */
export function main(argv: string[], io: { stdout?: (s: string) => void; stderr?: (s: string) => void; validatorRoot?: string } = {}): number {
  const stdout = io.stdout ?? (s => process.stdout.write(s));
  const stderr = io.stderr ?? (s => process.stderr.write(s));
  let args: Record<string, string> = {};
  let report: Report, code = 0;
  try {
    args = parseArgs(argv);
    report = review({ repo: args.repo ?? process.cwd(), base: args.base, head: args.head, author: args.author ?? "", validatorRoot: io.validatorRoot });
  } catch (e) {
    const message = e instanceof BotError ? e.message : `bot_crashed: ${(e as Error)?.stack ?? String(e)}`;
    report = errorReport(message);
    code = 2;
    stderr(`mini-apps-review: cannot judge, failing closed: ${message.split("\n")[0]}\n`);
  }
  const json = JSON.stringify(report, null, 2) + "\n";
  stdout(json);
  const text = summary(report);
  stderr(text);
  try {
    if (args.out) writeFileSync(args.out, json);
    if (args.summary) writeFileSync(args.summary, text);
  } catch (e) {
    stderr(`mini-apps-review: could not write the report file: ${(e as Error).message}\n`);
    return 2;
  }
  return code;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
