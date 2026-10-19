import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateProjection } from "../../install/install_miniapps";

// Mini-apps v2 Phase 0, P0-1 (MINIAPPS-PLATFORM-v2-design.md §1.1, §1.3, §8): the CI check over
// mini-apps/**. Every published manifest (mini-apps/catalog.json) is a valid v2 manifest by the ONE
// validator the control plane serves the catalog with, and its skill hash is the skill's bytes.
//
// 1. scripts/mini-apps-manifests.cjs and mini-apps/manifest.v2.schema.json are the control plane's
//    (control-plane/src/mini-apps-manifests.js, control-plane/src/mini-apps/manifest.v2.schema.json)
//    and the app's (src/lib/server/mini-apps/manifests/) byte for byte, pinned twice as the visibility
//    vocabulary is: by mini-apps/manifests.pins.json (byte-identical in the three repos) and by the
//    constants below (each repo's test holds the same three). With AV_CONTROLPLANE_DIR set to a
//    controlplane checkout, the shared files and the cp's vendored manifests are compared as bytes.
// 2. catalog.json lists every mini-apps/<id>/ that holds a manifest, and only those.
// 3. Every listed manifest validates; skills[0].sha256 is sha256(skills/<id>/SKILL.md) and its version
//    the skill's frontmatter version (§1.3: a skill edit is a manifest edit).
// 4. The v1 entries the cp serves from them are the ones this overlay's installer accepts.
// Nothing on a box reads these files yet (no skill, plugin or installer step): data only, no roll.
//   bun test scripts/tests/mini-app-manifests.test.ts

const MODULE_SHA256 = "5e64f8a3efbd315f628a6bf13cad35a47e0982501f29f70f3135d91a779775d4";
const SCHEMA_SHA256 = "ff2e958db499c33150851224bd20cbcf4e02ed9a0789ccc407c940ffb27871b7";
const PINS_SHA256 = "7137bfeda58b0469b28783af3f054d967cba2f3f18a08eca9b68c7afa4913fed";
const REPO = join(import.meta.dir, "..", "..");
const DIR = join(REPO, "mini-apps");
const m = createRequire(import.meta.url)("../mini-apps-manifests.cjs");
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const bytes = (path: string) => readFileSync(join(REPO, path));
const index = JSON.parse(bytes("mini-apps/catalog.json").toString("utf8"));
const manifest = (id: string) => JSON.parse(bytes(`mini-apps/${id}/manifest.json`).toString("utf8"));
/**
 * Fail closed on anything under mini-apps/ that is not a reviewed catalog file (security review
 * "authorization-reserved-namespace", shape a): the tree is a closed list, never "whatever manifest.json files exist".
 * Allowed: README.md, catalog.json, manifest.v2.schema.json, manifests.pins.json at the top; one directory
 * per catalog.json id holding manifest.json and optionally README.md. No symlink anywhere, no other name,
 * extension or case variant, no directory catalog.json does not list (and none it lists may be missing).
 */
const TOP_FILES = ["README.md", "catalog.json", "manifest.v2.schema.json", "manifests.pins.json"];
function treeViolations(dir: string, ids: string[]): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const st = lstatSync(join(dir, name));
    if (st.isSymbolicLink()) out.push(`${name}: symlink`);
    else if (st.isFile()) { if (!TOP_FILES.includes(name)) out.push(`${name}: unknown file`); }
    else if (!st.isDirectory()) out.push(`${name}: not a file or directory`);
    else if (!ids.includes(name)) out.push(`${name}/: not in catalog.json`);
    else {
      const inner = readdirSync(join(dir, name)).sort();
      for (const file of inner) {
        const fst = lstatSync(join(dir, name, file));
        if (fst.isSymbolicLink()) out.push(`${name}/${file}: symlink`);
        else if (!fst.isFile() || !["manifest.json", "README.md"].includes(file)) out.push(`${name}/${file}: unknown entry`);
      }
      if (!inner.includes("manifest.json")) out.push(`${name}/manifest.json: missing`);
    }
  }
  for (const id of ids) if (!readdirSync(dir).includes(id)) out.push(`${id}/: listed but missing`);
  return out;
}
const reasons = (result: { ok: boolean; errors?: { path: string; reason: string }[] }) =>
  result.ok ? [] : result.errors!.map(e => `${e.path} ${e.reason}`);

describe("the shared files", () => {
  test("module and schema hold the sha256 the cp and app also pin, in the pin file and in this test", () => {
    const pins = JSON.parse(bytes("mini-apps/manifests.pins.json").toString("utf8"));
    expect(sha256(bytes("scripts/mini-apps-manifests.cjs"))).toBe(MODULE_SHA256);
    expect(sha256(bytes("mini-apps/manifest.v2.schema.json"))).toBe(SCHEMA_SHA256);
    expect(pins.manifest).toBe(m.MANIFEST_VERSION);
    expect(pins.sha256).toEqual({ module: MODULE_SHA256, schema: SCHEMA_SHA256 });
    expect(sha256(bytes("mini-apps/manifests.pins.json"))).toBe(PINS_SHA256);
  });

  test("the schema file is the module SCHEMA, serialized", () => {
    expect(bytes("mini-apps/manifest.v2.schema.json").toString("utf8")).toBe(JSON.stringify(m.SCHEMA, null, 2) + "\n");
  });

  test.skipIf(!process.env.AV_CONTROLPLANE_DIR)("cmp: the control plane's copies and vendored manifests, byte for byte (AV_CONTROLPLANE_DIR)", () => {
    const cp = join(process.env.AV_CONTROLPLANE_DIR!, "control-plane", "src");
    const pairs = [["scripts/mini-apps-manifests.cjs", "mini-apps-manifests.js"],
      ...["manifest.v2.schema.json", "manifests.pins.json", "catalog.json", ...index.apps.map((id: string) => `${id}/manifest.json`)]
        .map(file => [`mini-apps/${file}`, `mini-apps/${file}`])];
    for (const [mine, theirs] of pairs) expect([mine, Buffer.compare(readFileSync(join(cp, theirs)), bytes(mine))]).toEqual([mine, 0]);
  });
});

describe("mini-apps/: the published catalog", () => {
  test("catalog.json is a valid index, in the order the cp serves, and mini-apps/ holds only reviewed catalog files", () => {
    expect(m.checkSchema(index, m.INDEX_SCHEMA)).toEqual([]);
    expect(index.apps).toEqual(["gold-stars", "dizko", "zzzbot", "slopfolio", "forkicks"]);
    expect(treeViolations(DIR, index.apps)).toEqual([]);
  });

  test("the closed tree refuses every stray form (fail closed, never skipped)", () => {
    const root = mkdtempSync(join(tmpdir(), "mini-app-tree-"));
    try {
      for (const file of TOP_FILES) writeFileSync(join(root, file), "{}");
      mkdirSync(join(root, "acme"));
      writeFileSync(join(root, "acme", "manifest.json"), "{}");
      expect(treeViolations(root, ["acme"])).toEqual([]);
      const cases: [string, () => void, string][] = [
        ["an unlisted app directory", () => { mkdirSync(join(root, "evil")); writeFileSync(join(root, "evil", "manifest.json"), "{}"); }, "evil/: not in catalog.json"],
        ["another extension", () => writeFileSync(join(root, "acme", "manifest.v3.json"), "{}"), "acme/manifest.v3.json: unknown entry"],
        // A name absent from the directory, so the variant is a file of its own on a case-insensitive disk too.
        ["a case variant", () => writeFileSync(join(root, "acme", "Readme.md"), "x"), "acme/Readme.md: unknown entry"],
        ["a top-level manifest", () => writeFileSync(join(root, "manifest.json"), "{}"), "manifest.json: unknown file"],
        ["a nested directory", () => mkdirSync(join(root, "acme", "sub")), "acme/sub: unknown entry"],
        ["a symlinked manifest", () => { rmSync(join(root, "acme", "manifest.json")); symlinkSync(join(root, "catalog.json"), join(root, "acme", "manifest.json")); }, "acme/manifest.json: symlink"],
        ["a symlinked app directory", () => symlinkSync(join(root, "acme"), join(root, "other")), "other: symlink"],
        ["a listed app with no directory", () => {}, "gone/: listed but missing"],
      ];
      for (const [why, plant, want] of cases) {
        plant();
        expect([why, treeViolations(root, ["acme", "gone"].slice(0, why.startsWith("a listed") ? 2 : 1)).includes(want)]).toEqual([why, true]);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("every listed manifest is a valid v2 manifest, and the catalog builds with none dropped", () => {
    for (const id of index.apps) expect([id, reasons(m.validateManifest(manifest(id)))]).toEqual([id, []]);
    const built = m.buildCatalog(index, Object.fromEntries(index.apps.map((id: string) => [id, manifest(id)])));
    expect([built.ok, built.dropped]).toEqual([true, []]);
  });

  test("each manifest's skill is its skills/<id>/SKILL.md: sha256 of the bytes, and the frontmatter version", () => {
    for (const id of index.apps) {
      const [skill] = manifest(id).skills;
      const file = bytes(skill.path);
      const version = /^---\n(?:.*\n)*?version: (\S+)\n(?:.*\n)*?---\n/.exec(file.toString("utf8"))?.[1];
      expect([id, skill.path, skill.sha256, skill.version]).toEqual([id, `skills/${id}/SKILL.md`, sha256(file), version]);
    }
  });

  test("the v1 entries the cp serves from them are the ones this overlay's installer accepts", () => {
    const entry = (opts: object) => (id: string) => {
      const { version, operations, skills } = m.v1Entry(manifest(id), opts);
      return { id, version, operations, skills };
    };
    for (const opts of [{}, { person: true }, { person: true, context: true }]) {
      const projection = { version: 1, apps: index.apps.map(entry(opts)) };
      expect(validateProjection(projection)).toEqual(projection);
    }
  });

  test("the validator refuses what the schema closes (a sample; the cp's test holds the full corpus)", () => {
    const fk = () => manifest("forkicks");
    const cases: [string, (x: any) => void, string][] = [
      ["missing visibility", x => { delete x.visibility; }, "/ required:visibility"],
      ["unknown key", x => { x.restricted = true; }, "/restricted additionalProperties"],
      ["wrong type", x => { x.operations[0].maxRequestBytes = "4096"; }, "/operations/0/maxRequestBytes type"],
      ["op of another app", x => { x.operations[0].name = "gold-stars.menu"; }, "/operations/0/name prefix"],
      ["an http: URL", x => { x.description = "http://example.com"; }, "/description http_url"],
      ["a code field", x => { x.operations[0].command = "bun run x.ts"; }, "/operations/0/command additionalProperties"],
      // Reserved namespaces: what an app may claim is pinned in the validator (FIRST_PARTY, RESERVED_IDS).
      ["a third party claiming a core prefix", x => { x.id = "acme"; x.skills[0] = { ...x.skills[0], name: "acme", path: "skills/acme/SKILL.md" };
        x.legacy = { prefixes: ["rolodex"] }; x.operations = [{ name: "rolodex.person", class: "read" }]; }, "/legacy first_party_only"],
      ["a reserved id", x => { x.id = "rolodex"; x.skills[0] = { ...x.skills[0], name: "rolodex", path: "skills/rolodex/SKILL.md" };
        x.operations = [{ name: "rolodex.person", class: "read" }]; }, "/id reserved"],
      ["internal kind for a non-core app", x => { x.service = { kind: "internal" }; }, "/service/kind internal_first_party_only"],
    ];
    for (const [why, mutate, want] of cases) {
      const value = fk();
      mutate(value);
      expect([why, reasons(m.validateManifest(value)).includes(want)]).toEqual([why, true]);
    }
  });
});
