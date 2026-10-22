// MINI-APPS v2 GENERIC (CLAIMS L19473; box contract review-b L19490; receipt contract context L19498 / lead L19499):
// a new generic app is a cp-only change. The installer accepts an app in neither reviewed table when its operations
// are exactly the generic set (or the read alone), skills == [id], and the cp's offer carries its SKILL.md bytes
// hashing to the offered sha256. A refused generic app fails only itself (`refused: [{ id, code }]`); a reviewed
// app never does (it keeps today's whole-stage failure).
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { BUNDLE_MAX_CHARS, GENERIC_OPERATIONS_ACCEPTED, PREVIOUS_REVIEWED_MINI_APPS, reconcileMiniApps, REFUSAL_CODES, REVIEWED_MINI_APPS, SKILL_MAX_BYTES, validateProjection } from "../install_miniapps";
import { EDGE_SKILL_NAMES } from "../paths";

const REPO = join(import.meta.dir, "..", "..");
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function home() {
  const root = mkdtempSync(join(tmpdir(), "curated-miniapps-generic-"));
  roots.push(root);
  return root;
}
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const st = statSync(path);
      if (st.isDirectory()) { out[relative(root, path) + "/"] = String(st.mode); walk(path); }
      else out[relative(root, path)] = `${st.mode}:${readFileSync(path, "base64")}`;
    }
  };
  walk(root);
  return out;
}
const OFFER = "cd".repeat(32);
const READ = "mini-app.read", CTX_READ = "mini-app.context.read", CTX_WRITE = "mini-app.context.write";
const GENERIC_OPS = [READ, CTX_READ, CTX_WRITE];
const TEXT = "---\nname: civic-board\nversion: 1.0.0\n---\n# Civic Board\nRead the board with mini-app.read.\n";
type Entry = { id: string; sha256: string; bytes: string };
type Delivery = { offer?: string; skills?: string };
const entry = (id: string, text: string | Buffer, digest = sha(text)): Entry => ({ id, sha256: digest, bytes: Buffer.from(text).toString("base64") });
const bundle = (...skills: Entry[]) => ({ offer: OFFER, skills: JSON.stringify({ version: 1, skills }) });
/** The entry the cp projects for a generic app: exactly today's shape, {id, version, operations, skills}. */
const generic = (id = "civic-board", operations: unknown = GENERIC_OPS) => ({ id, version: "1.0.0", operations, skills: [id] });
const gold = () => ({ ...REVIEWED_MINI_APPS[0], operations: [...REVIEWED_MINI_APPS[0].operations], skills: [...REVIEWED_MINI_APPS[0].skills] });
const dizko = () => ({ ...REVIEWED_MINI_APPS[1], operations: [...REVIEWED_MINI_APPS[1].operations], skills: [...REVIEWED_MINI_APPS[1].skills] });
const onDisk = (root: string) => readFileSync(join(root, "mini-apps.json"), "utf8");
const skillPath = (root: string, id: string) => join(root, "skills", id, "SKILL.md");
type Receipt = ReturnType<typeof reconcileMiniApps> & { refused?: { id: string; code: string }[] };
const REVIEWED_IDS = new Set<string>([...REVIEWED_MINI_APPS, ...PREVIOUS_REVIEWED_MINI_APPS].map(a => a.id));
/** The plugin's own installed() over the staged mini-apps.json (plugins/village-bridge/_mini_apps.py). */
function pluginInstalled(root: string, checks: [string, string][]): boolean[] {
  const code = "import importlib.util, json, pathlib, sys\n" +
    "spec = importlib.util.spec_from_file_location('mini', sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\n" +
    "print(json.dumps([m.installed(pathlib.Path(sys.argv[2]), a, o) for a, o in json.loads(sys.argv[3])]))";
  const run = spawnSync("python3", ["-I", "-c", code, join(REPO, "plugins", "village-bridge", "_mini_apps.py"), realpathSync(root), JSON.stringify(checks)], { encoding: "utf8" });
  expect([run.status, run.stderr]).toEqual([0, ""]);
  return JSON.parse(run.stdout);
}
/**
 * The receipt invariants the cp checks (context L19498): apps == projection minus refused ids, in projection order;
 * files == the skill paths of apps only; refused ids a subset of the projection's, no duplicates, no overlap with
 * apps; never a reviewed id; codes from the closed set; `refused` omitted when empty; mini-apps.json and
 * projectionSha256 are the accepted subset; verify with the same delivery recomputes the same receipt.
 */
function staged(projection: { version: number; apps: { id: string }[] }, root: string, delivery: Delivery = {}): Receipt {
  const receipt = reconcileMiniApps(projection, root, undefined, false, delivery) as Receipt;
  const refusedIds = (receipt.refused ?? []).map(r => r.id);
  const ids = projection.apps.map(a => a.id);
  expect(receipt.version).toBe(1);
  expect(receipt.staged).toBe(true);
  if (receipt.refused) expect(receipt.refused.length).toBeGreaterThan(0);
  expect(new Set(refusedIds).size).toBe(refusedIds.length);
  for (const id of refusedIds) expect(ids).toContain(id);
  for (const id of refusedIds) expect(REVIEWED_IDS.has(id)).toBe(false);
  for (const r of receipt.refused ?? []) expect(Object.keys(r).sort()).toEqual(["code", "id"]);
  for (const r of receipt.refused ?? []) expect(REFUSAL_CODES).toContain(r.code as typeof REFUSAL_CODES[number]);
  const accepted = projection.apps.filter(a => !refusedIds.includes(a.id));
  expect(receipt.apps.map(a => a.id)).toEqual(accepted.map(a => a.id));
  expect(receipt.files.map(f => f.path)).toEqual(accepted.map(a => `skills/${a.id}/SKILL.md`));
  const subset = JSON.stringify({ version: 1, apps: accepted });
  expect(receipt.projectionSha256).toBe(sha(subset));
  if (accepted.length || existsSync(join(root, "mini-apps.json"))) expect(onDisk(root)).toBe(subset);
  for (const f of receipt.files) expect(sha(readFileSync(join(root, f.path)))).toBe(f.sha256);
  expect(reconcileMiniApps(projection, root, undefined, true, delivery)).toEqual(receipt);
  return receipt;
}
/** The reviewed gold-stars + dizko still on the box and granted by the bridge, whatever happened to the generic app. */
function reviewedStaged(root: string) {
  expect(JSON.parse(onDisk(root)).apps.map((a: { id: string }) => a.id).slice(0, 2)).toEqual(["gold-stars", "dizko"]);
  expect(readFileSync(skillPath(root, "dizko"))).toEqual(readFileSync(join(REPO, "skills", "dizko", "SKILL.md")));
  expect(pluginInstalled(root, [["gold-stars", "rolodex.search"], ["dizko", CTX_WRITE]])).toEqual([true, true]);
}
function refusedAlone(app: unknown, delivery: Delivery, code: string) {
  const root = home();
  const receipt = staged({ version: 1, apps: [gold(), dizko(), app as { id: string }] }, root, delivery);
  expect(receipt.refused).toEqual([{ id: (app as { id: string }).id, code }]);
  expect(existsSync(skillPath(root, (app as { id: string }).id))).toBe(false);
  expect(receipt.skills.served).toEqual([]);
  reviewedStaged(root);
  return receipt;
}

test("the refusal codes are exactly the cp contract's six; the generic lists are exactly the bridge's APP_OPERATIONS_ACCEPTED", () => {
  expect([...REFUSAL_CODES]).toEqual(["offer_missing", "bundle_invalid", "sha_mismatch", "operations_not_generic", "shadows_reviewed", "budget"]);
  const plugin = readFileSync(join(REPO, "plugins", "village-bridge", "_mini_apps.py"), "utf8");
  const accepted = /^APP_OPERATIONS_ACCEPTED = \((.*)\)$/m.exec(plugin)![1];
  expect(JSON.parse("[" + accepted.replace(/\(/g, "[").replace(/,\)/g, "]").replace(/\)/g, "]") + "]")).toEqual(GENERIC_OPERATIONS_ACCEPTED.map(ops => [...ops]));
  // The box's id rule is inside the bridge's (re.fullmatch(r"[a-z][a-z0-9-]{0,63}", name)).
  expect(plugin).toContain('re.fullmatch(r"[a-z][a-z0-9-]{0,63}", name)');
});

test("a generic app whose offered SKILL.md hashes to the offered sha256 is staged with the cp's exact bytes; the bridge grants it", () => {
  for (const operations of GENERIC_OPERATIONS_ACCEPTED.map(ops => [...ops])) {
    const root = home();
    const projection = { version: 1, apps: [gold(), dizko(), generic("civic-board", operations)] };
    const delivery = bundle(entry("civic-board", TEXT));
    const receipt = staged(projection, root, delivery);
    expect(receipt).not.toHaveProperty("refused");
    // The authority file is the cp's projection byte for byte, so with nothing refused the hash is the cp's.
    expect(onDisk(root)).toBe(JSON.stringify(projection));
    expect(receipt.projectionSha256).toBe(sha(JSON.stringify(projection)));
    expect(readFileSync(skillPath(root, "civic-board"), "utf8")).toBe(TEXT);
    expect(statSync(skillPath(root, "civic-board")).mode & 0o777).toBe(0o600);
    expect(receipt.files.at(-1)).toEqual({ path: "skills/civic-board/SKILL.md", sha256: sha(TEXT) });
    expect(receipt.skills).toEqual({ offer: OFFER, served: ["civic-board"], fallback: [] });
    expect(validateProjection(projection, delivery)).toEqual(projection);
    const ops = [READ, CTX_READ, CTX_WRITE, "gold-stars.send"];
    expect(pluginInstalled(root, ops.map(op => ["civic-board", op] as [string, string]))).toEqual(ops.map(op => operations.includes(op)));
    reviewedStaged(root);
  }
});

test("sha_mismatch: bytes that do not hash to the offered sha256 refuse that app alone", () => {
  refusedAlone(generic(), bundle(entry("civic-board", TEXT + "planted", sha(TEXT))), "sha_mismatch");
  expect(() => validateProjection({ version: 1, apps: [generic()] }, bundle(entry("civic-board", TEXT, sha("x"))))).toThrow("sha_mismatch");
});

test("offer_missing: no offer, no entry for the app, or no well-formed offer digest; never a checkout copy", () => {
  const cases: Delivery[] = [
    {},
    bundle(entry("dizko", TEXT)),
    { skills: bundle(entry("civic-board", TEXT)).skills },
    { offer: OFFER.toUpperCase(), skills: bundle(entry("civic-board", TEXT)).skills },
    { offer: "not-a-digest", skills: bundle(entry("civic-board", TEXT)).skills },
  ];
  for (const delivery of cases) refusedAlone(generic(), delivery, "offer_missing");
  // Even when a checkout copy exists for that id, a generic app never falls back to it.
  const source = join(home(), "skills");
  cpSync(join(REPO, "skills"), source, { recursive: true });
  mkdirSync(join(source, "civic-board"));
  writeFileSync(join(source, "civic-board", "SKILL.md"), TEXT);
  const root = home();
  const receipt = reconcileMiniApps({ version: 1, apps: [gold(), generic()] }, root, source) as Receipt;
  expect(receipt.refused).toEqual([{ id: "civic-board", code: "offer_missing" }]);
  expect(existsSync(skillPath(root, "civic-board"))).toBe(false);
});

test("bundle_invalid: bad base64, oversize, non-UTF-8 or a malformed bundle refuse a generic app (a reviewed app keeps its fallback)", () => {
  const cases: Delivery[] = [
    bundle({ id: "civic-board", sha256: sha(TEXT), bytes: "not base64!" }),
    bundle({ id: "civic-board", sha256: "NOT-HEX", bytes: Buffer.from(TEXT).toString("base64") }),
    bundle(entry("civic-board", Buffer.alloc(SKILL_MAX_BYTES + 1, "a"))),
    bundle(entry("civic-board", Buffer.from([0xff, 0xfe, 0x41]))),
    { offer: OFFER, skills: "{not json" },
    { offer: OFFER, skills: JSON.stringify({ version: 1, skills: [{ ...entry("civic-board", TEXT), path: "skills/civic-board/SKILL.md" }] }) },
    { offer: OFFER, skills: JSON.stringify({ version: 2, skills: [entry("civic-board", TEXT)] }) },
  ];
  for (const delivery of cases) {
    const receipt = refusedAlone(generic(), delivery, "bundle_invalid");
    for (const f of receipt.skills.fallback) expect(["gold-stars", "dizko"]).toContain(f.id);
  }
  // The same malformed bundle leaves a reviewed app's fallback exactly as before.
  expect(refusedAlone(generic(), { offer: OFFER, skills: "{not json" }, "bundle_invalid").skills.fallback)
    .toEqual([{ id: "gold-stars", code: "mini_apps_skill_bundle_invalid" }, { id: "dizko", code: "mini_apps_skill_bundle_invalid" }]);
  // Exactly at the size cap is served.
  const root = home();
  expect(staged({ version: 1, apps: [generic()] }, root, bundle(entry("civic-board", Buffer.alloc(SKILL_MAX_BYTES, "a")))).skills.served).toEqual(["civic-board"]);
});

test("budget: a bundle over the box's caps (characters, entries) refuses a generic app with `budget`", () => {
  const big = { offer: OFFER, skills: JSON.stringify({ version: 1, skills: [entry("civic-board", TEXT), { id: "pad", sha256: sha("x"), bytes: "A".repeat(BUNDLE_MAX_CHARS) }] }) };
  const many = { offer: OFFER, skills: JSON.stringify({ version: 1, skills: [entry("civic-board", TEXT), ...Array.from({ length: 32 }, (_, i) => entry(`pad${i}`, "x"))] }) };
  for (const delivery of [big, many]) {
    const receipt = refusedAlone(generic(), delivery, "budget");
    expect(receipt.skills.fallback).toEqual([{ id: "gold-stars", code: "mini_apps_skill_bundle_invalid" }, { id: "dizko", code: "mini_apps_skill_bundle_invalid" }]);
  }
});

test("operations_not_generic: an unknown app that is not generic, or the generic set with any other operation, is refused alone", () => {
  const planted: unknown[] = [
    [...GENERIC_OPS, "mini-app.context.delete"], [READ, "gold-stars.send"], [...GENERIC_OPS, "gold-stars.send"], ["gold-stars.send"],
    [CTX_READ, READ, CTX_WRITE], [READ, CTX_WRITE, CTX_READ], [READ, READ], [READ, CTX_READ], [READ, CTX_WRITE], [CTX_READ, CTX_WRITE], [],
    [...REVIEWED_MINI_APPS[2].operations], [READ, "Mini-App.Context.Write"], [READ + " "], READ, null, { [READ]: true },
  ];
  for (const operations of planted) refusedAlone(generic("civic-board", operations), bundle(entry("civic-board", TEXT)), "operations_not_generic");
});

test("shadows_reviewed: an id the installer ships as a skill is refused alone and its baseline SKILL.md is untouched", () => {
  for (const id of EDGE_SKILL_NAMES.filter(name => !REVIEWED_IDS.has(name))) refusedAlone(generic(id), bundle(entry(id, TEXT)), "shadows_reviewed");
  // On a box that has the baseline file, it is left exactly as it is.
  const root = home(), id = EDGE_SKILL_NAMES.find(name => !REVIEWED_IDS.has(name))!;
  mkdirSync(join(root, "skills", id), { recursive: true });
  writeFileSync(skillPath(root, id), "baseline");
  expect(staged({ version: 1, apps: [gold(), generic(id)] }, root, bundle(entry(id, TEXT))).refused).toEqual([{ id, code: "shadows_reviewed" }]);
  expect(readFileSync(skillPath(root, id), "utf8")).toBe("baseline");
});

test("a reviewed id is never refused alone and never staged as a generic app: a mismatch fails the whole stage as today", () => {
  const all = { version: 1, apps: REVIEWED_MINI_APPS };
  const root = home();
  const receipt = staged(all as unknown as { version: number; apps: { id: string }[] }, root);
  expect(receipt).not.toHaveProperty("refused");
  expect(onDisk(root)).toBe(JSON.stringify(all));
  for (const id of [...REVIEWED_IDS]) {
    for (const operations of [GENERIC_OPS, [READ], [...GENERIC_OPS, "mini-app.context.delete"]]) {
      if ([...REVIEWED_MINI_APPS, ...PREVIOUS_REVIEWED_MINI_APPS].some(a => a.id === id && JSON.stringify(a.operations) === JSON.stringify(operations))) continue;
      const box = home();
      reconcileMiniApps({ version: 1, apps: [gold()] }, box);
      const before = snapshot(box);
      const others = id === "gold-stars" ? [dizko()] : [gold()];
      expect(() => reconcileMiniApps({ version: 1, apps: [...others, generic(id, operations)] }, box, undefined, false, bundle(entry(id, TEXT)))).toThrow("mini_apps_unreviewed_bundle");
      expect(snapshot(box)).toEqual(before);
    }
  }
  // dizko / mosaic carry exactly the generic set, but as reviewed apps: their checkout copy, today's fallback codes, never `refused`.
  const box = home();
  const r = staged({ version: 1, apps: [gold(), dizko()] }, box, bundle(entry("dizko", TEXT, sha("x"))));
  expect(r.skills.fallback).toEqual([{ id: "dizko", code: "mini_apps_skill_hash_mismatch" }]);
  expect(readFileSync(skillPath(box, "dizko"))).toEqual(readFileSync(join(REPO, "skills", "dizko", "SKILL.md")));
});

test("an unsafe id or a malformed generic entry fails the whole stage; nothing is written", () => {
  const delivery = bundle(entry("civic-board", TEXT));
  const fatal: [unknown, string][] = [
    [{ version: 2, apps: [gold()] }, "mini_apps_invalid_projection"],
    [{ version: 1, apps: [gold()], mcp: {} }, "mini_apps_invalid_projection"],
    [{ version: 1, apps: {} }, "mini_apps_invalid_projection"],
    [null, "mini_apps_invalid_projection"],
    [{ version: 1, apps: [gold(), "dizko"] }, "mini_apps_invalid_entry"],
    [{ version: 1, apps: [gold(), null] }, "mini_apps_invalid_entry"],
    [{ version: 1, apps: [gold(), [dizko()]] }, "mini_apps_invalid_entry"],
    [{ version: 1, apps: [gold(), { ...generic(), id: 7 }] }, "mini_apps_invalid_entry"],
    [{ version: 1, apps: [gold(), generic(), generic()] }, "mini_apps_unreviewed_bundle"],
    [{ version: 1, apps: [gold(), dizko(), { ...dizko(), operations: [READ] }] }, "mini_apps_unreviewed_bundle"],
    ...["../escape", "../../escape", "a/b", "civic/../board", ".hidden", "-lead", "Civic", "civic_board", "civic board", "", "a".repeat(41), "9lives"]
      .map(id => [{ version: 1, apps: [gold(), generic(id)] }, "mini_apps_invalid_entry"] as [unknown, string]),
    ...[{ ...generic(), version: "1" }, { ...generic(), version: 1 }, { ...generic(), skills: ["other"] }, { ...generic(), skills: [] },
      { ...generic(), skills: ["civic-board", "civic-board"] }, { ...generic(), hooks: ["sh"] }, { ...generic(), skillSha256: sha(TEXT) },
      { id: "civic-board", operations: GENERIC_OPS, skills: ["civic-board"] }]
      .map(app => [{ version: 1, apps: [gold(), app] }, "mini_apps_invalid_entry"] as [unknown, string]),
  ];
  for (const [value, code] of fatal) {
    const parent = home(), root = join(parent, "box");
    mkdirSync(root);
    reconcileMiniApps({ version: 1, apps: [gold()] }, root);
    const before = snapshot(parent);
    expect(() => reconcileMiniApps(value, root, undefined, false, delivery)).toThrow(code);
    expect(snapshot(parent)).toEqual(before);
  }
  // The longest safe id is 40 characters.
  const root = home(), id = "a".repeat(40);
  expect(staged({ version: 1, apps: [generic(id)] }, root, bundle(entry(id, TEXT))).refused).toBeUndefined();
});

test("the old fail-the-whole-reconcile case now stages the good apps, in projection order (library and CLI)", () => {
  const unknown = { id: "unreviewed", version: "1.0.0", operations: ["unreviewed.do"], skills: ["unreviewed"] };
  const projection = { version: 1, apps: [gold(), unknown, dizko(), generic("civic-board"), generic("no-offer"), generic("pinned-wrong")] };
  const delivery = bundle(entry("civic-board", TEXT), entry("pinned-wrong", TEXT + "x", sha(TEXT)));
  const root = home();
  const receipt = staged(projection, root, delivery);
  expect(receipt.apps.map(a => a.id)).toEqual(["gold-stars", "dizko", "civic-board"]);
  expect(receipt.refused).toEqual([{ id: "unreviewed", code: "operations_not_generic" }, { id: "no-offer", code: "offer_missing" }, { id: "pinned-wrong", code: "sha_mismatch" }]);
  expect(onDisk(root)).toBe(JSON.stringify({ version: 1, apps: [gold(), dizko(), generic("civic-board")] }));
  reviewedStaged(root);
  // The strict check keeps its all-or-nothing contract.
  expect(() => validateProjection(projection, delivery)).toThrow("operations_not_generic");
  // The exact command the cp runs, with the two delivery variables.
  const box = home();
  for (const args of [[], ["--verify"]]) {
    const run = spawnSync("bun", ["--no-env-file", "--no-install", "install/install_miniapps.ts", ...args], {
      cwd: REPO, input: JSON.stringify(projection), encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: box, HERMES_HOME: box, MINI_APPS_SKILLS_OFFER: delivery.offer, MINI_APPS_SKILLS: delivery.skills },
    });
    expect([run.status, run.stderr]).toEqual([0, ""]);
    expect(JSON.parse(run.stdout)).toEqual(receipt);
  }
});

test("verify recomputes the same subset: a generic app verified without its offer fails closed, never a checkout copy", () => {
  const root = home();
  const projection = { version: 1, apps: [gold(), generic()] };
  staged(projection, root, bundle(entry("civic-board", TEXT)));
  expect(() => reconcileMiniApps(projection, root, undefined, true)).toThrow("mini_apps_projection_mismatch");
  // Other offered bytes for the same app are drift on the staged file.
  expect(() => reconcileMiniApps(projection, root, undefined, true, bundle(entry("civic-board", TEXT + "x")))).toThrow("mini_apps_skill_mismatch");
  // A box-side edit of the staged SKILL.md is drift.
  writeFileSync(skillPath(root, "civic-board"), "edited on the box");
  expect(() => reconcileMiniApps(projection, root, undefined, true, bundle(entry("civic-board", TEXT)))).toThrow("mini_apps_skill_mismatch");
});

test("a box that refuses every desired app keeps its bridge credential; only an empty desired set revokes it", () => {
  const root = home();
  reconcileMiniApps({ version: 1, apps: [dizko()] }, root);
  writeFileSync(join(root, "village-bridge.json"), "managed bearer fixture");
  const receipt = staged({ version: 1, apps: [generic()] }, root);
  expect(receipt.refused).toEqual([{ id: "civic-board", code: "offer_missing" }]);
  expect(existsSync(join(root, "village-bridge.json"))).toBe(true);
  expect(JSON.parse(onDisk(root))).toEqual({ version: 1, apps: [] });
  expect(existsSync(skillPath(root, "dizko"))).toBe(false);
  reconcileMiniApps({ version: 1, apps: [] }, root);
  expect(existsSync(join(root, "village-bridge.json"))).toBe(false);
});

test("review-b N1 (box side): a symlinked skill directory or file for a generic app is refused before anything is written", () => {
  for (const target of ["skills", "skills/civic-board", "skills/civic-board/SKILL.md"]) {
    const root = home(), outside = home();
    mkdirSync(join(root, target, ".."), { recursive: true });
    symlinkSync(target.endsWith("SKILL.md") ? join(outside, "SKILL.md") : outside, join(root, target));
    expect(() => reconcileMiniApps({ version: 1, apps: [generic()] }, root, undefined, false, bundle(entry("civic-board", TEXT)))).toThrow("mini_apps_symlink_refused");
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(root, "mini-apps.json"))).toBe(false);
  }
});
