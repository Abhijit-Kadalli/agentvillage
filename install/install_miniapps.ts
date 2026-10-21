#!/usr/bin/env bun
/** Disk-only curated reconciliation. CP owns intent, leasing, restart and applied evidence. */
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, parse } from "node:path";
import { EDGE_SKILL_NAMES, hermesHome } from "./paths";
import { reconcileZzzManagedJob, verifyZzzManagedJob, zzzShippedFile, type ZzzShippedKind } from "./zzz_managed_job";

/**
 * ROLODEX.PERSON (rc42, CLAIMS 7799): the gold-stars entry also carries `rolodex.person` (a read of
 * another resident's public profile), appended LAST after ov#350's `rolodex.meeting` and
 * `skylight.status`. plugins/village-bridge/_mini_apps.py GOLD_STARS carries the same list; the
 * control-plane catalog's gold-stars entry moves to it only after boxes run this overlay, so the CP's
 * projection hash matches the receipt.
 *
 * NEW-03 (rc44, P-013): the dizko entry also carries `mini-app.context.read` and
 * `mini-app.context.write` (the app's own context namespace), after `mini-app.read`.
 * plugins/village-bridge/_mini_apps.py APP_OPERATIONS_ACCEPTED carries the same lists; the CP
 * projects them for dizko only after boxes run this overlay (BOX_DEFERRED_OPERATIONS until then).
 */
export const REVIEWED_MINI_APPS = [
  { id: "gold-stars", version: "1.1.0", operations: ["rolodex.search", "gold-stars.quota", "gold-stars.prepare", "gold-stars.send", "gold-stars.status", "gold-stars.cancel", "rolodex.meeting", "skylight.status", "rolodex.person"], skills: ["gold-stars"] },
  { id: "dizko", version: "1.0.0", operations: ["mini-app.read", "mini-app.context.read", "mini-app.context.write"], skills: ["dizko"] },
  { id: "forkicks", version: "1.0.0", operations: ["forkicks.menu", "forkicks.schedule", "forkicks.order.prepare", "forkicks.order.confirm", "forkicks.order.status", "forkicks.order.cancel"], skills: ["forkicks"] },
  // P-6 ZZZ-MINIAPP: restricted zzz.bot, five named operations (plugins/village-bridge/_mini_apps.py ZZZBOT, exact).
  { id: "zzzbot", version: "1.0.0", operations: ["zzz.list_rooms", "zzz.read_thread", "zzz.changes", "zzz.reply", "zzz.create_thread"], skills: ["zzzbot"] },
  // ov#441 S1 (lead RULING CLAIMS L16692/L16696): the ONLY gate for managed private-pair participation, a separate
  // cp catalog/allowlist entry granted per tenant at activation (the Mosaic restricted-entry pattern). Spelled
  // `zzz-bridge`: cp and app ids match ^[a-z0-9][a-z0-9-]{0,39}$ (no underscore; app#500 reads the same id).
  // Empty operations/skills: it grants no ordinary tool and stages no skill (_mini_apps.py ZZZ_BRIDGE, exact).
  { id: "zzz-bridge", version: "1.0.0", operations: [], skills: [] },
  { id: "slopfolio", version: "1.0.0", operations: ["slopfolio.prepare", "slopfolio.status"], skills: ["slopfolio"] },
  // MOSAIC (app#486, rides v2.1.9): restricted in the CP catalog (MINI_APPS_TENANT_ALLOWLIST key `mosaic`).
  // Dizko's shape: the public read first, then its own context namespace read and write, served per box.
  { id: "mosaic", version: "1.0.0", operations: ["mini-app.read", "mini-app.context.read", "mini-app.context.write"], skills: ["mosaic"] },
] as const;
/**
 * Earlier gold-stars entries, still staged byte for byte so this overlay can roll out BEFORE the CP
 * catalog moves (overlay first, then the catalog with a re-stage; never the reverse): the restored
 * eight-op entry (ov#350, _mini_apps.py GOLD_STARS_RESTORED; the CP's current entry, rolodex.person
 * refused under it) and the six-op entry before the restore (ov#343, GOLD_STARS_PREVIOUS; no meeting,
 * Skylight or person operation), and dizko's public read alone (NEW-03: the CP's entry until it
 * projects the context operations), and mosaic's the same way. Remove each after the CP catalog serves a newer
 * list everywhere.
 */
export const PREVIOUS_REVIEWED_MINI_APPS = [
  { id: "gold-stars", version: "1.1.0", operations: ["rolodex.search", "gold-stars.quota", "gold-stars.prepare", "gold-stars.send", "gold-stars.status", "gold-stars.cancel", "rolodex.meeting", "skylight.status"], skills: ["gold-stars"] },
  { id: "gold-stars", version: "1.1.0", operations: ["rolodex.search", "gold-stars.quota", "gold-stars.prepare", "gold-stars.send", "gold-stars.status", "gold-stars.cancel"], skills: ["gold-stars"] },
  { id: "dizko", version: "1.0.0", operations: ["mini-app.read"], skills: ["dizko"] },
  // MOSAIC: its read alone, the CP's entry for a box that does not take the context entry (as dizko's).
  { id: "mosaic", version: "1.0.0", operations: ["mini-app.read"], skills: ["mosaic"] },
] as const;
type ReviewedApp = typeof REVIEWED_MINI_APPS[number] | typeof PREVIOUS_REVIEWED_MINI_APPS[number];
/**
 * Skills the installer ships to every box (install/paths.ts). The helper may write a desired app's
 * SKILL.md over one (the same source bytes), but never removes one: an app missing from `desired`
 * only loses its native permission (mini-apps.json), never a baseline skill (rc37's helper unlinked
 * the baseline gold-stars SKILL.md; the re-cut for rc41 does not).
 */
export const SHIPPED_SKILLS: ReadonlySet<string> = new Set<string>(EDGE_SKILL_NAMES);
const owned = (id: string) => !SHIPPED_SKILLS.has(id);
const hasSkill = (app: ReviewedApp) => app.skills.length > 0;
type Projection = { version: 1; apps: ReviewedApp[] };
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export const ZZZ_BRIDGE_ID = "zzz-bridge";
const ZZZ_SHIM = "agentvillage_zzz_pairs.sh";
const ZZZ_MANAGED_FILES = [`scripts/${ZZZ_SHIM}`, "prompts/participate.md"] as const;
/**
 * ov#441 S1: managed ZZZ participation (the "Edge — zzz pairs" job, its shim, prompt and cursor state) is on only
 * when the validated cp projection carries BOTH zzzbot and zzz-bridge. Nothing else (no overlay constant, no
 * environment variable, no probe of the app) is read; bridge without zzzbot stages nothing.
 */
export function zzzParticipation(projection: { apps: readonly { id: string }[] }): boolean {
  return projection.apps.some(app => app.id === "zzzbot") && projection.apps.some(app => app.id === ZZZ_BRIDGE_ID);
}
/**
 * ov#441 S4-r (lead RULING CLAIMS L17296): what marks a box this installer ever turned managed ZZZ on for. A stage
 * writes the managed files (skills/zzzbot/scripts, prompts) before it publishes authority, and the job's shim before
 * it creates the job; every teardown removes the shim only after the job is gone (and a revocation removes the files
 * and state after that), so the installer never leaves a managed job without a marker. With the gate off and no
 * marker, the stage is main's stage: no jobs.json parse, no scripts/ walk, no Hermes call, nothing written. The
 * plugin creates the cursor lock before any other state file, so the two fixed state names cover its state.
 */
/**
 * S5 + N12 (review-b recheck L17481, lead RULING, nonav OWNER CALL pick (a)): a marker counts only when its final lstat
 * is a REGULAR file (never a symlink, directory, FIFO or dangling link), and an installer-written marker (the two
 * shims, participate.md) only when its bytes are a version this installer shipped (zzzShippedFile). The plugin's two
 * state files cannot be byte-matched (their content is per box): they count as regular files in a real zzzbot/ folder.
 */
const ZZZ_MARKERS: readonly { parts: readonly string[]; kind: ZzzShippedKind | null }[] = [
  { parts: ["scripts", ZZZ_SHIM], kind: "shim" }, { parts: ["skills", "zzzbot", "scripts", ZZZ_SHIM], kind: "shim" },
  { parts: ["skills", "zzzbot", "prompts", "participate.md"], kind: "prompt" },
  { parts: ["zzzbot", "managed-pairs.json"], kind: null }, { parts: ["zzzbot", "managed-pairs.lock"], kind: null }];
/**
 * Every marker path, never through a symlinked or non-directory parent: `ours` when one counts, and `notOurs`, the
 * relative names of the objects at a marker path that do not (left in place; they trigger nothing). No parse, and a
 * read only of a regular file at an installer-written marker path (its sha256); an lstat that fails is no marker.
 */
export function zzzMarkerScan(home: string): { ours: boolean; notOurs: string[] } {
  let ours = false;
  const notOurs: string[] = [];
  for (const { parts, kind } of ZZZ_MARKERS) {
    const found = zzzMarkerAt(home, parts, kind);
    if (found === "ours") ours = true;
    else if (found === "not_ours") notOurs.push(parts.join("/"));
  }
  return { ours, notOurs };
}
/** One marker path: "absent" (also behind a missing, symlinked or non-directory parent), "ours" or "not_ours". */
function zzzMarkerAt(home: string, parts: readonly string[], kind: ZzzShippedKind | null): "absent" | "ours" | "not_ours" {
  let path = home;
  try {
    for (const part of parts.slice(0, -1)) {
      path = join(path, part);
      const meta = lstatSync(path);
      if (!meta.isDirectory() || meta.isSymbolicLink()) return "absent";
    }
    path = join(path, parts[parts.length - 1]);
    if (kind) return zzzShippedFile(path, kind);
    return lstatSync(path).isFile() ? "ours" : "not_ours";
  } catch { return "absent"; }
}
/** A managed file under skills/zzzbot (the stage's own copy of the shim, or participate.md), as a marker path. */
const zzzManagedAt = (home: string, relative: typeof ZZZ_MANAGED_FILES[number]) =>
  zzzMarkerAt(home, ["skills", "zzzbot", ...relative.split("/")], relative.startsWith("scripts/") ? "shim" : "prompt");
export function zzzMarkerOnDisk(home: string): boolean {
  const { ours, notOurs } = zzzMarkerScan(home);
  noteNotOurs(notOurs);
  return ours;
}
let zzzNoticeLogged = false;
/** One stderr line per CLI run (names and a code only; the cp discards helper stderr): what was left as not ours. */
function noteNotOurs(notOurs: string[]): void {
  if (!import.meta.main || zzzNoticeLogged || !notOurs.length) return;
  zzzNoticeLogged = true;
  console.error(JSON.stringify({ notice: "zzz_not_ours", paths: notOurs }));
}
function exists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; }
}
/** Never traverse a symlink, including any parent of HERMES_HOME or the source. */
function safePath(path: string): void {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split("/").filter(Boolean)) {
    current = join(current, part);
    if (exists(current) && lstatSync(current).isSymbolicLink()) throw new Error("mini_apps_symlink_refused");
  }
}
function regular(path: string): void {
  safePath(path);
  if (exists(path) && !lstatSync(path).isFile()) throw new Error("mini_apps_non_file");
}
export function validateProjection(value: unknown): Projection {
  if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== "apps,version" || !("version" in value) || value.version !== 1 || !("apps" in value) || !Array.isArray(value.apps)) throw new Error("mini_apps_invalid_projection");
  const seen = new Set<string>();
  const apps = value.apps.map((app: unknown) => {
    if (!app || typeof app !== "object" || !("id" in app) || typeof app.id !== "string" || !("version" in app) || !("operations" in app) || !("skills" in app)) throw new Error("mini_apps_invalid_entry");
    const reviewed = ([...REVIEWED_MINI_APPS, ...PREVIOUS_REVIEWED_MINI_APPS] as readonly ReviewedApp[]).find(x => x.id === app.id && JSON.stringify(app.operations) === JSON.stringify(x.operations));
    if (!reviewed || seen.has(app.id) || Object.keys(app).sort().join(",") !== "id,operations,skills,version" || app.version !== reviewed.version || JSON.stringify(app.operations) !== JSON.stringify(reviewed.operations) || JSON.stringify(app.skills) !== JSON.stringify(reviewed.skills)) throw new Error("mini_apps_unreviewed_bundle");
    seen.add(app.id);
    return reviewed;
  });
  return { version: 1, apps };
}
function atomic(path: string, bytes: string | Buffer): void {
  regular(path);
  safePath(dirname(path));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.mini-apps-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally { if (exists(temporary)) unlinkSync(temporary); }
}
function removeZzzManagedState(home: string): void {
  const folder = join(home, "zzzbot");
  safePath(folder);
  if (!exists(folder)) return;
  if (!lstatSync(folder).isDirectory()) throw new Error("zzz_state_dir_invalid");
  // N12: only a regular file by one of the plugin's state names is removed. Any other name in the folder (a resident's
  // file) is never touched, and the folder then stays (rmdir's ENOTEMPTY); a non-regular object by a state name is not
  // ours either and stays the same way.
  for (const name of readdirSync(folder)) {
    if (!zzzStateName(name)) continue;
    const path = join(folder, name);
    if (lstatSync(path).isFile()) unlinkSync(path);
  }
  try { rmdirSync(folder); } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOTEMPTY")) throw error;
  }
}
const zzzStateName = (name: string) => name === "managed-pairs.json" || name === "managed-pairs.lock" || /^\.managed-[0-9]+$/.test(name);
/** N12: removes only the installer's own managed files (a shipped version's bytes); anything else by their names stays. */
function removeZzzManagedFiles(home: string): void {
  for (const relative of ZZZ_MANAGED_FILES)
    if (zzzManagedAt(home, relative) === "ours") unlinkSync(join(home, "skills", "zzzbot", relative));
}
function hasZzzManagedState(home: string): boolean {
  const folder = join(home, "zzzbot");
  safePath(folder);
  if (!exists(folder)) return false;
  if (!lstatSync(folder).isDirectory()) throw new Error("zzz_state_dir_invalid");
  return readdirSync(folder).some(name => zzzStateName(name) && lstatSync(join(folder, name)).isFile());
}
/**
 * ov#441 S1, fail closed: a stage whose projection is unreadable or malformed (or that fails for any other reason)
 * leaves managed participation OFF. Best effort, each step on its own: remove the job (and its shim), the staged
 * managed files and the cursor state. The stage still fails, so the cp retries; the next good stage reinstalls
 * when the projection carries zzz-bridge. A failed removal is the same `zzz_job_*` operator alert as on revocation.
 */
export function failClosedZzz(home: string): void {
  // S4-r: no marker, nothing of ours (a stage that failed before writing one created no job): main's failed stage.
  if (!zzzMarkerOnDisk(home)) return;
  // A failed job removal keeps the shim (zzz_managed_job removes it only after the job), so the box stays marked.
  try { reconcileZzzManagedJob(home, false); } catch { /* next reconcile retries */ }
  for (const relative of ZZZ_MANAGED_FILES) {
    try {
      safePath(home);
      if (zzzManagedAt(home, relative) === "ours") unlinkSync(join(home, "skills", "zzzbot", relative));
    } catch { /* refused path: left for the operator */ }
  }
  try { removeZzzManagedState(home); } catch { /* refused path: left for the operator */ }
}
/**
 * MINIAPPS v2 Phase 2, skill delivery (lanes-context/MINIAPPS-V2-SKILL-DELIVERY-design.md): the cp may
 * hand this installer each app's reviewed SKILL.md bytes BESIDE the projection, in two environment
 * variables (an older installer ignores both; the projection on stdin stays byte for byte today's):
 *   MINI_APPS_SKILLS_OFFER  the cp's offer digest (64 hex), echoed in the receipt so the cp can tell an
 *                           offer this box already took (or refused) from a new one; never interpreted;
 *   MINI_APPS_SKILLS        {"version":1,"skills":[{"id","sha256","bytes":<base64>}]}.
 * An app's served bytes are used only when they decode (strict base64, at most SKILL_MAX_BYTES, UTF-8)
 * and hash to the entry's sha256. ANY failure falls back to the pinned checkout copy (today's bytes) for
 * that app alone, with a code in the receipt; a bad bundle falls back for every app. A baseline skill
 * (SHIPPED_SKILLS) always keeps its checkout copy (code mini_apps_skill_baseline when one is offered). A skill problem
 * never fails the stage, so it never takes Gold Stars (or any other app) down. Nothing is fetched: no
 * URL, no path from the cp is ever opened; the target is always skills/<id>/SKILL.md for an id
 * validateProjection accepted.
 */
export const SKILL_MAX_BYTES = 32768;
export const BUNDLE_MAX_CHARS = 98304;
export const SKILL_FALLBACK_CODES = ["mini_apps_skill_bundle_invalid", "mini_apps_skill_invalid_entry", "mini_apps_skill_oversize", "mini_apps_skill_hash_mismatch", "mini_apps_skill_not_utf8", "mini_apps_skill_baseline"] as const;
type FallbackCode = typeof SKILL_FALLBACK_CODES[number];
export type SkillDelivery = { offer?: string; skills?: string };
type ServedEntry = { bytes: Buffer; code?: undefined } | { bytes?: undefined; code: FallbackCode };
const HEX64 = /^[a-f0-9]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const closed = (value: unknown, keys: string) => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === keys;
function servedEntry(entry: { sha256: unknown; bytes: unknown }): ServedEntry {
  if (typeof entry.sha256 !== "string" || !HEX64.test(entry.sha256) || typeof entry.bytes !== "string" || !entry.bytes.length || !BASE64.test(entry.bytes)) return { code: "mini_apps_skill_invalid_entry" };
  const bytes = Buffer.from(entry.bytes, "base64");
  if (bytes.length > SKILL_MAX_BYTES) return { code: "mini_apps_skill_oversize" };
  if (hash(bytes) !== entry.sha256) return { code: "mini_apps_skill_hash_mismatch" };
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return { code: "mini_apps_skill_not_utf8" }; }
  return { bytes };
}
export function parseSkillDelivery(delivery: SkillDelivery = {}): { offer: string | null; entries: Map<string, ServedEntry>; code?: FallbackCode } {
  const offer = typeof delivery.offer === "string" && HEX64.test(delivery.offer) ? delivery.offer : null;
  const entries = new Map<string, ServedEntry>();
  const raw = delivery.skills;
  if (raw === undefined || raw === "") return { offer, entries };
  try {
    if (typeof raw !== "string" || raw.length > BUNDLE_MAX_CHARS) throw new Error("bundle");
    const doc = JSON.parse(raw);
    if (!closed(doc, "skills,version") || doc.version !== 1 || !Array.isArray(doc.skills) || doc.skills.length > 32) throw new Error("bundle");
    for (const entry of doc.skills) {
      if (!closed(entry, "bytes,id,sha256") || typeof entry.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(entry.id) || entries.has(entry.id)) throw new Error("bundle");
      entries.set(entry.id, servedEntry(entry));
    }
  } catch { return { offer, entries: new Map(), code: "mini_apps_skill_bundle_invalid" }; }
  return { offer, entries };
}
export function reconcileMiniApps(value: unknown, home = hermesHome(), source = resolve(import.meta.dir, "../skills"), verify = false, delivery: SkillDelivery = {}) {
  const projection = validateProjection(value);
  const served = parseSkillDelivery(delivery);
  const servedIds: string[] = [];
  const fallback: { id: string; code: FallbackCode }[] = [];
  const bytes = JSON.stringify(projection);
  const target = join(home, "mini-apps.json");
  const credential = join(home, "village-bridge.json");
  if (projection.apps.length === 0) regular(credential);
  regular(target);
  const files: { path: string; sha256: string }[] = [];
  // Preflight every exact owned path, never recursively remove a resident's files.
  for (const app of REVIEWED_MINI_APPS) if (hasSkill(app)) regular(join(home, "skills", app.id, "SKILL.md"));
  // No desired apps and no mini-app state on the box (every non-cohort box): write nothing at all.
  const stateless = () => !exists(target) && !exists(credential) &&
    REVIEWED_MINI_APPS.every(app => !hasSkill(app) || !owned(app.id) || !exists(join(home, "skills", app.id, "SKILL.md")));
  const desired = projection.apps.filter(hasSkill).map(app => {
    const entry = served.entries.get(app.id);
    let content: Buffer;
    // review-b S1: a baseline skill this installer ships to every box (SHIPPED_SKILLS: gold-stars) is never
    // replaced by served bytes, valid or not; any entry for one is refused with its own code.
    // The managed participation prompt and native gate are reviewed with the
    // zzzbot skill as one overlay contract; do not take unreviewed served copy.
    if (entry?.bytes && owned(app.id) && app.id !== "zzzbot") {
      content = entry.bytes;
      servedIds.push(app.id);
    } else {
      const code: FallbackCode | undefined = entry && (!owned(app.id) || app.id === "zzzbot") ? "mini_apps_skill_baseline" : entry?.code ?? served.code;
      if (code) fallback.push({ id: app.id, code });
      // The pinned checkout copy: today's source, today's checks.
      const path = join(source, app.id, "SKILL.md");
      regular(path);
      content = readFileSync(path);
    }
    files.push({ path: `skills/${app.id}/SKILL.md`, sha256: hash(content) });
    return { app, content };
  });
  const zzzManaged = zzzParticipation(projection);
  // S4-r: gate off and no marker on disk is the early return. Every ZZZ step below runs only for zzzManaged (install)
  // or zzzTeardown (a box that was on: remove the job, shim, files and state, loudly when that cannot be confirmed).
  const zzzTeardown = !zzzManaged && zzzMarkerOnDisk(home);
  const zzzManagedFiles = ZZZ_MANAGED_FILES;
  // N12: only a stage that writes them preflights the managed paths; a teardown removes only its own files and leaves
  // anything else by their names (a resident's file, a symlink, a directory) in place, so nothing there fails it.
  if (zzzManaged) for (const relative of zzzManagedFiles) regular(join(home, "skills", "zzzbot", relative));
  const zzzFiles = zzzManaged ? zzzManagedFiles.map(relative => {
    const sourcePath = join(source, "zzzbot", relative);
    regular(sourcePath);
    const content = readFileSync(sourcePath);
    const path = `skills/zzzbot/${relative}`;
    files.push({ path, sha256: hash(content) });
    return { path: join(home, path), content };
  }) : [];
  if (verify) {
    if (!(projection.apps.length === 0 && stateless()) && (!exists(target) || readFileSync(target, "utf8") !== bytes)) throw new Error("mini_apps_projection_mismatch");
    if (projection.apps.length === 0 && exists(credential)) throw new Error("mini_apps_credential_removal_pending");
    for (const { app, content } of desired) if (!readFileSync(join(home, "skills", app.id, "SKILL.md")).equals(content)) throw new Error("mini_apps_skill_mismatch");
    for (const { path, content } of zzzFiles) if (!readFileSync(path).equals(content)) throw new Error("mini_apps_skill_mismatch");
    for (const app of REVIEWED_MINI_APPS) if (hasSkill(app) && owned(app.id) && !projection.apps.some(x => x.id === app.id) && exists(join(home, "skills", app.id, "SKILL.md"))) throw new Error("mini_apps_removal_pending");
    if (zzzTeardown && zzzManagedFiles.some(relative => zzzManagedAt(home, relative) === "ours")) throw new Error("mini_apps_removal_pending");
    if (zzzTeardown && hasZzzManagedState(home)) throw new Error("mini_apps_removal_pending");
    // review-b N3: the job record too (read-only, no Hermes call): exactly the installer's job while the pair is
    // projected, none once it is not. As every job step, only from the CLI (in-process callers never own a job).
    if (import.meta.main && (zzzManaged || zzzTeardown)) {
      const script = zzzFiles.find(({ path }) => path.endsWith(`/scripts/${ZZZ_SHIM}`))?.content ?? null;
      try { verifyZzzManagedJob(home, zzzManaged, script); } catch { throw new Error(zzzManaged ? "mini_apps_job_mismatch" : "mini_apps_removal_pending"); }
    }
  } else if (!(projection.apps.length === 0 && stateless())) {
    // Fail closed even if copying/removal is interrupted. Publish desired authority after the skills are staged.
    atomic(target, JSON.stringify({ version: 1, apps: [] }));
    if (projection.apps.length === 0 && exists(credential)) unlinkSync(credential);
    for (const app of REVIEWED_MINI_APPS) {
      const path = join(home, "skills", app.id, "SKILL.md");
      if (hasSkill(app) && owned(app.id) && !projection.apps.some(x => x.id === app.id) && exists(path)) unlinkSync(path);
    }
    for (const { app, content } of desired) atomic(join(home, "skills", app.id, "SKILL.md"), content);
    for (const { path, content } of zzzFiles) atomic(path, content);
    // Publish desired authority, THEN install the job (review-b S3). A failed job install fails the stage and the CLI
    // tears down only the zzz-managed job, shim, files and state (failClosedZzz), so every other app (Gold Stars, For
    // Kicks, ...) keeps the authority just published. A projected pair with no exact job record runs nothing: every
    // managed path needs the installer's job (_zzz_managed.managed_context). The job exists only when the projection
    // grants zzzbot AND zzz-bridge (S1).
    atomic(target, bytes);
    if (import.meta.main && zzzManaged) reconcileZzzManagedJob(home, true);
    // On removal authority disappears before the job teardown; the managed files and state (markers) go only after it.
    if (zzzTeardown) {
      if (import.meta.main) reconcileZzzManagedJob(home, false);
      removeZzzManagedFiles(home);
      removeZzzManagedState(home);
    }
  } else if (import.meta.main && !verify && zzzTeardown) {
    // Heal a previous interrupted uninstall even when the projection is gone.
    reconcileZzzManagedJob(home, false);
    removeZzzManagedFiles(home);
    removeZzzManagedState(home);
  }
  // `skills` also marks an installer that can take served bytes (an older one never writes it).
  return { version: 1, projectionSha256: hash(bytes), files, apps: projection.apps.map(({ id, version }) => ({ id, version })), staged: true,
    skills: { offer: served.offer, served: servedIds, fallback } };
}
if (import.meta.main) {
  const verify = process.argv.includes("--verify");
  try {
    if (process.argv.slice(2).some(x => x !== "--verify")) throw new Error("mini_apps_invalid_argument");
    const input = await Bun.stdin.text();
    if (Buffer.byteLength(input) > 16384) throw new Error("mini_apps_projection_too_large");
    const delivery = { offer: process.env.MINI_APPS_SKILLS_OFFER, skills: process.env.MINI_APPS_SKILLS };
    console.log(JSON.stringify(reconcileMiniApps(JSON.parse(input), hermesHome(), undefined, verify, delivery)));
  } catch {
    // S1: an unreadable or malformed projection (or any failed stage) is OFF for managed ZZZ participation.
    if (!verify) failClosedZzz(hermesHome());
    console.error(JSON.stringify({ error: "mini_apps_reconcile_failed" }));
    process.exitCode = 1;
  }
}
