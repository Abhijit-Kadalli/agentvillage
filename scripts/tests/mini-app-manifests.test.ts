import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
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

const MODULE_SHA256 = "739b695164a133ac2ac2d9b5d80407778ab3e4676bcc85c095190446b18d328c";
const SCHEMA_SHA256 = "ff2e958db499c33150851224bd20cbcf4e02ed9a0789ccc407c940ffb27871b7";
const PINS_SHA256 = "6e13afc53823acfd12505c7d9ac9ee78cd080f68d6696f390638f71212791308";
const REPO = join(import.meta.dir, "..", "..");
const DIR = join(REPO, "mini-apps");
const m = createRequire(import.meta.url)("../mini-apps-manifests.cjs");
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const bytes = (path: string) => readFileSync(join(REPO, path));
const index = JSON.parse(bytes("mini-apps/catalog.json").toString("utf8"));
const manifest = (id: string) => JSON.parse(bytes(`mini-apps/${id}/manifest.json`).toString("utf8"));
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
  test("catalog.json is a valid index naming every manifest directory, in the order the cp serves", () => {
    expect(m.checkSchema(index, m.INDEX_SCHEMA)).toEqual([]);
    expect(index.apps).toEqual(["gold-stars", "dizko", "zzzbot", "slopfolio", "forkicks"]);
    const dirs = readdirSync(DIR).filter(name => statSync(join(DIR, name)).isDirectory() && existsSync(join(DIR, name, "manifest.json")));
    expect(dirs.sort()).toEqual([...index.apps].sort());
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
    ];
    for (const [why, mutate, want] of cases) {
      const value = fk();
      mutate(value);
      expect([why, reasons(m.validateManifest(value)).includes(want)]).toEqual([why, true]);
    }
  });
});
