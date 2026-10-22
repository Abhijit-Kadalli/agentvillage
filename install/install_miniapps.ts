#!/usr/bin/env bun
/** Disk-only curated reconciliation. CP owns intent, leasing, restart and applied evidence. */
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, parse } from "node:path";
import { EDGE_SKILL_NAMES, hermesHome, RETIRED_SKILL_DIRS } from "./paths";

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
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
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
/**
 * MINI-APPS v2 GENERIC (CLAIMS L19473; box contract review-b L19490, receipt contract context L19498 / lead
 * L19499): an app in neither reviewed table is accepted when it is a GENERIC app, so adding one is a cp-only
 * change. Per app, in projection order:
 *   1. the id must match GENERIC_ID (^[a-z][a-z0-9-]{0,39}$: the served bundle's id rule AND the bridge's,
 *      plugins/village-bridge/_mini_apps.py, so the box never stages an id its bridge would refuse);
 *   2. a REVIEWED id takes today's path only (exact id + operations + version + skills, else the WHOLE stage
 *      fails as today): a reviewed id is never refused alone and never staged as a generic app;
 *   3. an id that names a skill something else owns is refused: `shadows_reviewed`. That is a skill the
 *      installer ships (SHIPPED_SKILLS), a retired one (RETIRED_SKILL_DIRS), any skill directory in this
 *      overlay checkout (approval, recall, agent-profile, hooks, ... : every skill another installer step
 *      stages), or a `skills/<id>/` that already exists on the box unless it holds the SKILL.md this installer
 *      wrote there (GENERIC_STATE, per file). The repo carries no list of Hermes's bundled skill names, so a
 *      bundled or resident skill is caught by that last rule (its directory exists and is not ours);
 *   4. operations must be EXACTLY one of GENERIC_OPERATIONS_ACCEPTED (the bridge's APP_OPERATIONS_ACCEPTED, the
 *      same lists in the same order; the cp has no other operations gate before this one):
 *      `operations_not_generic`;
 *   5. keys exactly id, operations, skills, version; skills exactly [id]; a semver version (the bridge's rule);
 *   6. its SKILL.md comes ONLY from the cp's offer (MINI_APPS_SKILLS + a well-formed MINI_APPS_SKILLS_OFFER),
 *      never from a checkout copy: no offer or no entry for it `offer_missing`; a bundle over the box's caps
 *      `budget`; any other bad bundle or entry (keys, strict base64, at most SKILL_MAX_BYTES, UTF-8)
 *      `bundle_invalid`; bytes that do not hash to the entry's sha256 `sha_mismatch`. The pin is the offer's
 *      sha256 (the cp offers bytes only when they equal its validated manifest pin); the box reads no sha or
 *      path from the projection or anywhere else.
 * Ownership and removal are PER FILE: GENERIC_STATE (`mini-apps-generic.json`, written only by this installer)
 * records, per generic id, the sha256 of the SKILL.md this installer wrote. The installer overwrites or unlinks
 * `skills/<id>/SKILL.md` only while that file is a regular file hashing to a recorded sha; otherwise the file is
 * not ours, is never touched, and ownership is dropped. A generic id that was staged and is no longer accepted
 * (left the projection, or refused) loses its SKILL.md (and its directory when empty) on the next stage;
 * --verify fails `mini_apps_removal_pending` while such a file of ours remains. Before any skill file is written
 * the state holds both the on-disk sha and the new one, and the result last, so an interrupted stage never loses
 * ownership of a file it may have written. A malformed state file is fatal (`mini_apps_generic_state_invalid`).
 * A refused app fails ONLY itself: the receipt carries `refused: [{ id, code }]` (omitted when nothing is
 * refused, so today's receipts are byte-identical), `apps` / `files` / mini-apps.json / projectionSha256 cover
 * exactly the projection minus the refused ids, in projection order, and --verify recomputes that same subset
 * (a generic app verified without its offer is refused again, so verify fails closed on the authority file).
 * FATAL (the whole stage fails, nothing written, as before): a projection that is not exactly
 * {version: 1, apps: [...]}, an entry that is not an object, an id that is not a string or fails GENERIC_ID,
 * a duplicate id, a reviewed id that matches no reviewed entry, a generic entry that fails rule 5, and every
 * filesystem check (symlinks, non-files, a reviewed app's missing checkout copy).
 */
export const GENERIC_OPERATIONS_ACCEPTED = [["mini-app.read", "mini-app.context.read", "mini-app.context.write"], ["mini-app.read"]] as const;
export const GENERIC_ID = /^[a-z][a-z0-9-]{0,39}$/;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/;
export const REFUSAL_CODES = ["offer_missing", "bundle_invalid", "sha_mismatch", "operations_not_generic", "shadows_reviewed", "budget"] as const;
export type RefusalCode = typeof REFUSAL_CODES[number];
export type GenericApp = { id: string; version: string; operations: string[]; skills: string[] };
type StagedApp = ReviewedApp | GenericApp;
type Projection = { version: 1; apps: StagedApp[] };
type Staged = { app: StagedApp; generic?: Buffer };
const ALL_REVIEWED = [...REVIEWED_MINI_APPS, ...PREVIOUS_REVIEWED_MINI_APPS] as readonly ReviewedApp[];
const REVIEWED_IDS: ReadonlySet<string> = new Set(ALL_REVIEWED.map(x => x.id));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** A generic app's SKILL.md from the cp's offer, or the refusal code. Never a checkout copy. */
function offered(served: ReturnType<typeof parseSkillDelivery>, id: string): Buffer | RefusalCode {
  if (served.code) return served.budget ? "budget" : "bundle_invalid";
  const entry = served.entries.get(id);
  if (!served.offer || !entry) return "offer_missing";
  if (entry.code) return entry.code === "mini_apps_skill_hash_mismatch" ? "sha_mismatch" : "bundle_invalid";
  return entry.bytes;
}
/** Skill names something other than a generic app owns, whatever the box holds (see rule 3). */
const STATIC_SHADOWS: ReadonlySet<string> = new Set<string>([...EDGE_SKILL_NAMES, ...RETIRED_SKILL_DIRS]);
export const GENERIC_STATE = "mini-apps-generic.json";
/** Per generic id, the sha256s of the SKILL.md this installer wrote (GENERIC_STATE); absent = none. Malformed is fatal. */
function ownedGeneric(home: string, source: string): Map<string, string[]> {
  const path = join(home, GENERIC_STATE);
  regular(path);
  if (!exists(path)) return new Map();
  try {
    if (lstatSync(path).size > 65536) throw new Error("size");
    const doc = JSON.parse(readFileSync(path, "utf8"));
    if (!closed(doc, "skills,version") || doc.version !== 1 || !doc.skills || typeof doc.skills !== "object" || Array.isArray(doc.skills)) throw new Error("shape");
    const entries = Object.entries(doc.skills as Record<string, unknown>);
    if (entries.length > 256) throw new Error("size");
    for (const [id, shas] of entries) {
      if (!GENERIC_ID.test(id) || REVIEWED_IDS.has(id) || STATIC_SHADOWS.has(id) || exists(join(source, id)) || !Array.isArray(shas) || shas.length < 1 || shas.length > 2 ||
          shas.some(x => typeof x !== "string" || !HEX64.test(x)) || new Set(shas).size !== shas.length) throw new Error("entry");
    }
    return new Map(entries as [string, string[]][]);
  } catch { throw new Error("mini_apps_generic_state_invalid"); }
}
/** The sha256 of skills/<id>/SKILL.md when it is a plain regular file this installer wrote (a recorded sha), else null. */
function ownedFile(home: string, recorded: Map<string, string[]>): (id: string) => string | null {
  return id => {
    const shas = recorded.get(id);
    const path = join(home, "skills", id, "SKILL.md");
    if (!shas) return null;
    try {
      safePath(path);
      if (!exists(path) || !lstatSync(path).isFile() || lstatSync(path).size > SKILL_MAX_BYTES) return null;
      const digest = hash(readFileSync(path));
      return shas.includes(digest) ? digest : null;
    } catch { return null; }
  };
}
/** Rule 3 on a box: static names, a checkout skill directory, or an existing skills/<id>/ not holding our own SKILL.md. */
function shadowsOnBox(home: string, source: string, ours: (id: string) => string | null): (id: string) => boolean {
  return id => STATIC_SHADOWS.has(id) || exists(join(source, id)) || (exists(join(home, "skills", id)) && ours(id) === null);
}
function checkApp(app: Record<string, unknown> & { id: string }, served: ReturnType<typeof parseSkillDelivery>, shadows: (id: string) => boolean): Staged | { code: RefusalCode } {
  if (!GENERIC_ID.test(app.id)) throw new Error("mini_apps_invalid_entry");
  if (REVIEWED_IDS.has(app.id)) {
    const reviewed = ALL_REVIEWED.find(x => x.id === app.id && same(app.operations, x.operations));
    if (!reviewed || Object.keys(app).sort().join(",") !== "id,operations,skills,version" || app.version !== reviewed.version || !same(app.skills, reviewed.skills)) throw new Error("mini_apps_unreviewed_bundle");
    return { app: reviewed };
  }
  if (shadows(app.id)) return { code: "shadows_reviewed" };
  const operations = GENERIC_OPERATIONS_ACCEPTED.find(ops => same(app.operations, ops));
  if (!operations) return { code: "operations_not_generic" };
  if (Object.keys(app).sort().join(",") !== "id,operations,skills,version" || typeof app.version !== "string" || !SEMVER.test(app.version) || !same(app.skills, [app.id])) throw new Error("mini_apps_invalid_entry");
  const bytes = offered(served, app.id);
  if (typeof bytes === "string") return { code: bytes };
  return { app: { id: app.id, version: app.version, operations: [...operations], skills: [app.id] }, generic: bytes };
}
function resolveApps(value: unknown, served: ReturnType<typeof parseSkillDelivery>, shadows: (id: string) => boolean): { projection: Projection; staged: Staged[]; refused: { id: string; code: RefusalCode }[]; intentEmpty: boolean } {
  if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== "apps,version" || !("version" in value) || value.version !== 1 || !("apps" in value) || !Array.isArray(value.apps)) throw new Error("mini_apps_invalid_projection");
  const seen = new Set<string>();
  const staged: Staged[] = [];
  const refused: { id: string; code: RefusalCode }[] = [];
  for (const app of value.apps as unknown[]) {
    if (!app || typeof app !== "object" || Array.isArray(app) || !("id" in app) || typeof app.id !== "string") throw new Error("mini_apps_invalid_entry");
    if (seen.has(app.id)) throw new Error("mini_apps_unreviewed_bundle");
    seen.add(app.id);
    const result = checkApp(app as Record<string, unknown> & { id: string }, served, shadows);
    if ("code" in result) refused.push({ id: app.id, code: result.code });
    else staged.push(result);
  }
  return { projection: { version: 1, apps: staged.map(x => x.app) }, staged, refused, intentEmpty: value.apps.length === 0 };
}
/** All or nothing: the projection with every app accepted (a generic app needs its offer), or the first refusal's code. */
export function validateProjection(value: unknown, delivery: SkillDelivery = {}): Projection {
  const { projection, refused } = resolveApps(value, parseSkillDelivery(delivery), id => STATIC_SHADOWS.has(id));
  if (refused.length) throw new Error(refused[0].code);
  return projection;
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
export function parseSkillDelivery(delivery: SkillDelivery = {}): { offer: string | null; entries: Map<string, ServedEntry>; code?: FallbackCode; budget?: boolean } {
  const offer = typeof delivery.offer === "string" && HEX64.test(delivery.offer) ? delivery.offer : null;
  const entries = new Map<string, ServedEntry>();
  const raw = delivery.skills;
  if (raw === undefined || raw === "") return { offer, entries };
  try {
    if (typeof raw !== "string") throw new Error("bundle");
    if (raw.length > BUNDLE_MAX_CHARS) throw new Error("budget");
    const doc = JSON.parse(raw);
    if (!closed(doc, "skills,version") || doc.version !== 1 || !Array.isArray(doc.skills)) throw new Error("bundle");
    if (doc.skills.length > 32) throw new Error("budget");
    for (const entry of doc.skills) {
      if (!closed(entry, "bytes,id,sha256") || typeof entry.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(entry.id) || entries.has(entry.id)) throw new Error("bundle");
      entries.set(entry.id, servedEntry(entry));
    }
  } catch (error) {
    // A box-side cap (BUNDLE_MAX_CHARS, 32 entries) is `budget` for a generic app; the same fallback for a reviewed one.
    return { offer, entries: new Map(), code: "mini_apps_skill_bundle_invalid", ...(error instanceof Error && error.message === "budget" ? { budget: true } : {}) };
  }
  return { offer, entries };
}
export function reconcileMiniApps(value: unknown, home = hermesHome(), source = resolve(import.meta.dir, "../skills"), verify = false, delivery: SkillDelivery = {}) {
  const served = parseSkillDelivery(delivery);
  const target = join(home, "mini-apps.json");
  const credential = join(home, "village-bridge.json");
  regular(target);
  // Per app: a refused generic app fails only itself (REFUSAL_CODES); everything else here is as before.
  const state = join(home, GENERIC_STATE);
  const recorded = ownedGeneric(home, source);
  const ours = ownedFile(home, recorded);
  const { projection, staged, refused, intentEmpty } = resolveApps(value, served, shadowsOnBox(home, source, ours));
  const accepted = staged.filter(x => x.generic).map(x => x.app.id);
  // Previously staged generic apps no longer accepted: their SKILL.md goes (removal), the directory when empty.
  const leaving = [...recorded.keys()].filter(id => !accepted.includes(id));
  const servedIds: string[] = [];
  const fallback: { id: string; code: FallbackCode }[] = [];
  const bytes = JSON.stringify(projection);
  // The bridge credential goes only when the cp desires no app at all, never because this box refused one.
  if (intentEmpty) regular(credential);
  const files: { path: string; sha256: string }[] = [];
  // Preflight every exact owned path, never recursively remove a resident's files.
  for (const app of REVIEWED_MINI_APPS) regular(join(home, "skills", app.id, "SKILL.md"));
  for (const { app, generic } of staged) if (generic) regular(join(home, "skills", app.id, "SKILL.md"));
  // No desired apps and no mini-app state on the box (every non-cohort box): write nothing at all.
  const stateless = () => !exists(target) && !exists(credential) && !exists(state) &&
    REVIEWED_MINI_APPS.every(app => !owned(app.id) || !exists(join(home, "skills", app.id, "SKILL.md")));
  const desired = staged.map(({ app, generic }) => {
    const entry = served.entries.get(app.id);
    let content: Buffer;
    // A generic app: the offered bytes resolveApps checked against the offer's sha256 (no checkout copy, no fallback code).
    if (generic) {
      servedIds.push(app.id);
      files.push({ path: `skills/${app.id}/SKILL.md`, sha256: hash(generic) });
      return { app, content: generic };
    }
    // review-b S1: a baseline skill this installer ships to every box (SHIPPED_SKILLS: gold-stars) is never
    // replaced by served bytes, valid or not; any entry for one is refused with its own code.
    if (entry?.bytes && owned(app.id)) {
      content = entry.bytes;
      servedIds.push(app.id);
    } else {
      const code: FallbackCode | undefined = entry && !owned(app.id) ? "mini_apps_skill_baseline" : entry?.code ?? served.code;
      if (code) fallback.push({ id: app.id, code });
      // The pinned checkout copy: today's source, today's checks.
      const path = join(source, app.id, "SKILL.md");
      regular(path);
      content = readFileSync(path);
    }
    files.push({ path: `skills/${app.id}/SKILL.md`, sha256: hash(content) });
    return { app, content };
  });
  if (verify) {
    if (!(projection.apps.length === 0 && stateless()) && (!exists(target) || readFileSync(target, "utf8") !== bytes)) throw new Error("mini_apps_projection_mismatch");
    if (intentEmpty && exists(credential)) throw new Error("mini_apps_credential_removal_pending");
    for (const { app, content } of desired) if (!readFileSync(join(home, "skills", app.id, "SKILL.md")).equals(content)) throw new Error("mini_apps_skill_mismatch");
    for (const app of REVIEWED_MINI_APPS) if (owned(app.id) && !projection.apps.some(x => x.id === app.id) && exists(join(home, "skills", app.id, "SKILL.md"))) throw new Error("mini_apps_removal_pending");
    for (const id of leaving) if (ours(id) !== null) throw new Error("mini_apps_removal_pending");
  } else if (!(projection.apps.length === 0 && stateless())) {
    // Fail closed even if copying/removal is interrupted. Publish desired authority last.
    // Ownership first: every file of ours on disk now, plus each file about to be written, so an interrupted
    // stage never forgets a file it may have written. Only files that are ours right now are carried.
    const before = new Map<string, string[]>();
    for (const id of recorded.keys()) { const digest = ours(id); if (digest) before.set(id, [digest]); }
    for (const { app, generic } of staged) if (generic) before.set(app.id, [...new Set([...(before.get(app.id) ?? []), hash(generic)])]);
    const record = (map: Map<string, string[]>) => atomic(state, JSON.stringify({ version: 1, skills: Object.fromEntries([...map].sort(([a], [b]) => a < b ? -1 : 1)) }));
    if (before.size || recorded.size) record(before);
    atomic(target, JSON.stringify({ version: 1, apps: [] }));
    if (intentEmpty && exists(credential)) unlinkSync(credential);
    for (const app of REVIEWED_MINI_APPS) {
      const path = join(home, "skills", app.id, "SKILL.md");
      if (owned(app.id) && !projection.apps.some(x => x.id === app.id) && exists(path)) unlinkSync(path);
    }
    for (const id of leaving) {
      // Only our own file (a recorded sha, a plain file) is ever unlinked; anything else is left as it is.
      const dir = join(home, "skills", id);
      if (ours(id) === null) continue;
      unlinkSync(join(dir, "SKILL.md"));
      if (readdirSync(dir).length === 0) rmdirSync(dir);
    }
    for (const { app, content } of desired) atomic(join(home, "skills", app.id, "SKILL.md"), content);
    atomic(target, bytes);
    // The result: exactly the files this stage wrote (a leaving id's ownership ends with its file).
    if (before.size || recorded.size) record(new Map(staged.filter(x => x.generic).map(({ app, generic }) => [app.id, [hash(generic!)]])));
  }
  // `skills` also marks an installer that can take served bytes (an older one never writes it).
  return { version: 1, projectionSha256: hash(bytes), files, apps: projection.apps.map(({ id, version }) => ({ id, version })), staged: true,
    skills: { offer: served.offer, served: servedIds, fallback }, ...(refused.length ? { refused } : {}) };
}
if (import.meta.main) {
  try {
    if (process.argv.slice(2).some(x => x !== "--verify")) throw new Error("mini_apps_invalid_argument");
    const input = await Bun.stdin.text();
    if (Buffer.byteLength(input) > 16384) throw new Error("mini_apps_projection_too_large");
    const delivery = { offer: process.env.MINI_APPS_SKILLS_OFFER, skills: process.env.MINI_APPS_SKILLS };
    console.log(JSON.stringify(reconcileMiniApps(JSON.parse(input), hermesHome(), undefined, process.argv.includes("--verify"), delivery)));
  } catch {
    console.error(JSON.stringify({ error: "mini_apps_reconcile_failed" }));
    process.exitCode = 1;
  }
}
