import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as R from "../mini-apps-review";

// Mini-apps v2 Phase 0, P0-3 (MINIAPPS-PLATFORM-v2-design.md §5, §6.1, §6.3): the deterministic review.
// Every fixture is invented (the app "tinyshop", its skill, its secrets); the only real inputs are the
// five published manifests, run as a no-change pull request at the end. The secret shapes are built by
// concatenation so this file holds no literal token.
//   bun test scripts/tests/mini-apps-review.test.ts

const REPO = join(import.meta.dir, "..", "..");
const V = R.loadValidator(REPO);
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

const SKILL = "---\nname: tinyshop\ndescription: An invented shop used only by these tests.\nversion: 1.0.0\nauthor: Test\n---\n\n# Tiny Shop\n\nUse the village tool only.\n";
function manifest(visibility = "sandbox"): any {
  return {
    manifest: 2, id: "tinyshop", name: "Tiny Shop", version: "1.0.0", description: "An invented shop used only by these tests.",
    homepage: "https://tinyshop.example.org", visibility,
    permissions: [{ kind: "read", label: "Read the menu", description: "Read the invented menu." }],
    service: { kind: "https-json", baseUrl: "https://api.tinyshop.example.org", auth: { mode: "app-token", secretRef: "MINI_APP_TINYSHOP_TOKEN" } },
    operations: [
      { name: "tinyshop.menu", class: "read" },
      { name: "tinyshop.order.prepare", class: "prepare" },
      { name: "tinyshop.order.confirm", class: "needs-card", maxRequestBytes: 65536, timeoutMs: 60000, approval: { prepare: "tinyshop.order.prepare" } },
    ],
    skills: [{ name: "tinyshop", version: "1.0.0", sha256: sha256(SKILL), path: "skills/tinyshop/SKILL.md" }],
  };
}
const json = (x: unknown) => JSON.stringify(x, null, 2) + "\n";
const MP = "mini-apps/tinyshop/manifest.json", SP = "skills/tinyshop/SKILL.md", CP = "mini-apps/tinyshop/conformance.json";
const CATALOG = json({ catalog: 2, apps: ["tinyshop"] });
type Files = Record<string, string | null>;
const baseFiles = (m = manifest()): Files => ({ "mini-apps/catalog.json": CATALOG, [MP]: json(m), [SP]: SKILL });

/** An in-memory pull request: base and head file maps (null deletes), modes optional. */
function source(base: Files, head: Files, opts: { author?: string; modes?: Record<string, string>; conf?: R.ConformanceRun } = {}): R.Source {
  const after: Files = { ...base, ...head };
  const files: R.Change[] = [];
  for (const path of [...new Set([...Object.keys(base), ...Object.keys(head)])].sort()) {
    const b = base[path] ?? null, h = after[path] ?? null;
    if (b === h) continue;
    files.push({ path, status: b === null ? "A" : h === null ? "D" : "M", oldMode: b === null ? "000000" : "100644", newMode: h === null ? "000000" : opts.modes?.[path] ?? "100644" });
  }
  const blob = (map: Files) => (path: string) => (map[path] == null ? null : Buffer.from(map[path]!));
  return {
    files, base: blob(base), head: blob(after), headSha: "f".repeat(40), author: opts.author ?? "someone",
    ...(opts.conf ? { conformance: () => opts.conf! } : {}),
    added: path => {
      const old = new Set((base[path] ?? "").split("\n"));
      return (after[path] ?? "").split("\n").map((text, i) => ({ line: i + 1, text })).filter(l => !old.has(l.text));
    },
  };
}
/** Review a change to the tinyshop manifest: `edit` mutates a copy of the base manifest. */
function pr(edit: (m: any) => void, o: { base?: any; extra?: Files; skill?: string; author?: string; modes?: Record<string, string>; conf?: R.ConformanceRun | ((head: any) => R.ConformanceRun) } = {}) {
  const b = o.base ?? manifest();
  const h = clone(b);
  edit(h);
  const head: Files = { [MP]: json(h), ...(o.skill !== undefined ? { [SP]: o.skill } : {}), ...(o.extra ?? {}) };
  const conf = typeof o.conf === "function" ? o.conf(h) : o.conf;
  return R.evaluate(source(baseFiles(b), head, { author: o.author, modes: o.modes, conf }), V);
}
const codes = (r: R.Report) => r.findings.map(f => f.code);
const has = (r: R.Report, code: string, severity?: string) => r.findings.some(f => f.code === code && (!severity || f.severity === severity));
const noM = (r: R.Report) => r.findings.filter(f => f.severity === "M").map(f => `${f.code} ${f.text}`);
const patch = (m: any) => { m.version = "1.0.1"; };

describe("the fixture", () => {
  test("is a valid v2 manifest by the shared validator, so every finding below is the check under test", () => {
    expect(V.validateManifest(manifest()).errors ?? []).toEqual([]);
    expect(V.validateManifest(manifest("everyone")).errors ?? []).toEqual([]);
  });
});

describe("paths: the lane classifier", () => {
  const c = (...paths: string[]) => R.classify(paths.map(path => ({ path, status: "M", oldMode: "100644", newMode: "100644" })));
  test("one id's mini-apps/<id>/ and skills/<id>/ is a manifest lane; its lane is the manifest's visibility", () => {
    expect(c(MP, SP)).toEqual({ id: "tinyshop", core: [] });
    const r = pr(m => { m.description = "Reworded."; patch(m); });
    expect([r.lane, r.manifest, r.verdict]).toEqual(["sandbox", "tinyshop@1.0.1", "PASS"]);
    expect(pr(m => { m.description = "Reworded."; patch(m); }, { base: manifest("admins") }).lane).toBe("admins");
    expect(pr(m => { m.description = "Reworded."; patch(m); }, { base: manifest("everyone") }).lane).toBe("everyone");
  });
  test("two ids is core", () => {
    expect(c(MP, "mini-apps/other/manifest.json").id).toBeNull();
    expect(c(SP, "skills/other/SKILL.md").id).toBeNull();
    const r = pr(patch, { extra: { "skills/other/SKILL.md": "x\n" } });
    expect([r.lane, r.verdict, has(r, "core_path", "S")]).toEqual(["core", "NEEDS_HUMAN", true]);
  });
  test("a skills/ change only is the app's lane (and its hash then has to match)", () => {
    expect(c(SP)).toEqual({ id: "tinyshop", core: [] });
    const edited = SKILL.replace("only.", "only, always.");
    const stale = pr(() => {}, { skill: edited });
    expect([stale.lane, stale.verdict, has(stale, "skill_hash_mismatch", "M")]).toEqual(["sandbox", "FAIL", true]);
    const synced = pr(m => { m.skills[0].sha256 = sha256(edited); patch(m); }, { skill: edited });
    expect([synced.verdict, noM(synced)]).toEqual(["PASS", []]);
  });
  test("a skills/ change for an id with no manifest (a baseline skill) is core", () => {
    const r = R.evaluate(source(baseFiles(), { "skills/rolodex/SKILL.md": "x\n" }), V);
    expect([r.lane, r.verdict, has(r, "no_manifest")]).toEqual(["core", "NEEDS_HUMAN", true]);
  });
  test("a script change is core; every gate file says so", () => {
    expect(c(MP, "scripts/mini-apps-review.ts").id).toBeNull();
    for (const gate of R.GATE_FILES) {
      const r = pr(patch, { extra: { [gate]: "changed\n" } });
      expect([gate, r.lane, r.verdict, has(r, "gate_changed")]).toEqual([gate, "core", "NEEDS_HUMAN", true]);
    }
  });
  test("the gate list is pinned here, not read back from the script (P0-1's and P0-5's gates included)", () => {
    expect([...R.GATE_FILES].sort()).toEqual([
      ".github/workflows/mini-apps-review.yml", "mini-apps/catalog.json", "mini-apps/manifest.v2.schema.json", "mini-apps/manifests.pins.json",
      "package.json", "scripts/mini-apps-conformance.ts", "scripts/mini-apps-manifests.cjs", "scripts/mini-apps-review.ts",
      "scripts/tests/mini-app-manifests.test.ts", "scripts/tests/mini-apps-conformance.test.ts", "scripts/tests/mini-apps-review.test.ts",
    ]);
    const r = pr(patch, { extra: { "scripts/mini-apps-conformance.ts": "changed\n" } });
    expect([r.lane, r.verdict, has(r, "gate_changed")]).toEqual(["core", "NEEDS_HUMAN", true]);
  });
  test("other core shapes: no files, a top-level mini-apps file, an id the id rule refuses", () => {
    expect(R.classify([]).id).toBeNull();
    expect(c("mini-apps/README.md").id).toBeNull();
    expect(c("mini-apps/Tiny_Shop/manifest.json").id).toBeNull();
    expect(c("skills/marketplace.json").id).toBeNull();
  });
  test("a deleted manifest is core", () => {
    const r = R.evaluate(source(baseFiles(), { [MP]: null, [SP]: null }), V);
    expect([r.lane, r.verdict, has(r, "manifest_deleted")]).toEqual(["core", "NEEDS_HUMAN", true]);
  });
  test("inside the lane only the catalog files: no code, no symlink", () => {
    const script = pr(patch, { extra: { "skills/tinyshop/run.sh": "echo hi\n" } });
    expect([script.verdict, has(script, "path_unknown_file", "M")]).toEqual(["FAIL", true]);
    expect(has(pr(patch, { extra: { "mini-apps/tinyshop/extra.json": "{}\n" } }), "path_unknown_file", "M")).toBe(true);
    expect(has(pr(patch, { extra: { "mini-apps/tinyshop/README.md": "# Tiny\n" } }), "path_unknown_file")).toBe(false);
    // A committed conformance.json is never trusted (release, L14465): the bot runs the suite itself.
    const committed = pr(patch, { extra: { [CP]: "{}\n" } });
    expect([committed.verdict, committed.findings.find(x => x.code === "path_unknown_file")?.text]).toEqual(["FAIL", "a committed conformance.json is never trusted: the bot runs the suite itself; remove it"]);
    const link = pr(patch, { extra: { "mini-apps/tinyshop/README.md": "../../x" }, modes: { "mini-apps/tinyshop/README.md": "120000" } });
    expect([link.verdict, has(link, "path_symlink", "M")]).toEqual(["FAIL", true]);
  });
});

describe("the verdict mapping (§6.3)", () => {
  const f = (severity: R.Severity, code = "x"): R.Finding => ({ code, severity, text: "t" });
  const table: [R.Lane, R.Finding[], R.Verdict][] = [
    ["sandbox", [], "PASS"], ["admins", [], "PASS"], ["everyone", [], "PASS"], ["core", [], "NEEDS_HUMAN"],
    ["sandbox", [f("N")], "PASS"], ["admins", [f("N")], "PASS"], ["everyone", [f("N")], "PASS"], ["core", [f("N")], "NEEDS_HUMAN"],
    ["sandbox", [f("S")], "PASS"], ["admins", [f("S")], "NEEDS_HUMAN"], ["everyone", [f("S")], "NEEDS_HUMAN"], ["core", [f("S")], "NEEDS_HUMAN"],
    ["sandbox", [f("S"), f("M")], "FAIL"], ["admins", [f("M")], "FAIL"], ["everyone", [f("M")], "FAIL"], ["core", [f("M")], "FAIL"],
    // A §5 rule needs the human read even in sandbox.
    ["sandbox", [f("S", "needs_card_review")], "NEEDS_HUMAN"], ["sandbox", [f("S", "oauth_review")], "NEEDS_HUMAN"],
    ["sandbox", [f("N", "author_unverified")], "PASS"],
  ];
  for (const [lane, findings, want] of table) {
    test(`${lane} + [${findings.map(x => x.severity + (x.code === "x" ? "" : `:${x.code}`)).join(",")}] -> ${want}`, () => {
      expect(R.verdictOf(lane, findings)).toBe(want);
    });
  }
});

describe("author", () => {
  test("no owner.github yet: N author_unverified, never a pass on its own and never a FAIL", () => {
    const r = pr(patch);
    const author = r.findings.filter(x => x.code.startsWith("author"));
    expect(author.map(x => [x.code, x.severity])).toEqual([["author_unverified", "N"]]);
  });
  test("an owner opens it: N; anyone else (staff included): S, the human read, never M", () => {
    const owned = (m: any) => { m.owner = { github: ["tiny-dev", "Tiny-Ops"] }; };
    const base = manifest(); owned(base);
    expect(has(pr(patch, { base, author: "tiny-ops" }), "author_is_owner", "N")).toBe(true);
    const other = pr(patch, { base, author: "staffer" });
    expect([has(other, "author_not_owner", "S"), other.verdict, noM(other)]).toEqual([true, "NEEDS_HUMAN", []]);
  });
});

describe("schema: the shared validator", () => {
  test("fires on what the validator refuses and is silent on a valid manifest", () => {
    const bad = pr(m => { m.restricted = true; patch(m); });
    expect([bad.verdict, bad.findings.find(x => x.code === "schema_invalid")?.text]).toEqual(["FAIL", "/restricted additionalProperties"]);
    expect(has(pr(patch), "schema_invalid")).toBe(false);
  });
  test("a manifest that is not JSON fails", () => {
    const r = R.evaluate(source(baseFiles(), { [MP]: "{ nope" }), V);
    expect([r.verdict, has(r, "manifest_unparseable", "M")]).toEqual(["FAIL", true]);
  });
  test("the catalog: a manifest the cp would drop fails; one it does not list is a note", () => {
    const wrongId = pr(m => {
      m.id = "tinyshop2"; m.skills[0] = { ...m.skills[0], name: "tinyshop2", path: "skills/tinyshop2/SKILL.md" };
      m.service.auth.secretRef = "MINI_APP_TINYSHOP2_TOKEN";
      m.operations.forEach((op: any) => { op.name = op.name.replace("tinyshop.", "tinyshop2."); });
      m.operations[2].approval.prepare = "tinyshop2.order.prepare";
    });
    expect(has(wrongId, "catalog_dropped", "M")).toBe(true);
    const r = R.evaluate(source({ ...baseFiles(), "mini-apps/catalog.json": json({ catalog: 2, apps: ["dizko"] }) }, { [MP]: json({ ...manifest(), version: "1.0.1" }) }), V);
    expect(has(r, "catalog_unlisted", "N")).toBe(true);
  });
});

describe("the validator is loaded only at its pinned sha (fail closed)", () => {
  const root = () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "mini-apps-review-pins-"));
    for (const rel of [R.VALIDATOR_PATH, R.SCHEMA_PATH, R.PINS_PATH]) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      copyFileSync(join(REPO, rel), join(dir, rel));
    }
    return dir;
  };
  test("the pinned copy loads", () => {
    const dir = root();
    try { expect(typeof R.loadValidator(dir).validateManifest).toBe("function"); } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  const tampers: [string, (dir: string) => void][] = [
    ["one byte of the validator", dir => { const p = join(dir, R.VALIDATOR_PATH); writeFileSync(p, readFileSync(p, "utf8").replace("const MAX_ERRORS = 32;", "const MAX_ERRORS = 33;")); }],
    ["the schema file", dir => { const p = join(dir, R.SCHEMA_PATH); writeFileSync(p, readFileSync(p, "utf8") + " "); }],
    ["the pins file", dir => { const p = join(dir, R.PINS_PATH); writeFileSync(p, readFileSync(p, "utf8").replace(/"module": "[0-9a-f]{64}"/, `"module": "${"0".repeat(64)}"`)); }],
    ["a pins file that is not JSON", dir => writeFileSync(join(dir, R.PINS_PATH), "{")],
    ["a missing validator", dir => rmSync(join(dir, R.VALIDATOR_PATH))],
  ];
  for (const [why, tamper] of tampers) {
    test(`refuses ${why}`, () => {
      const dir = root();
      try {
        tamper(dir);
        expect(() => R.loadValidator(dir)).toThrow(R.BotError);
        let out = "";
        const code = R.main(["--base", "HEAD", "--head", "HEAD", "--repo", REPO], { validatorRoot: dir, stdout: s => { out += s; }, stderr: () => {} });
        const report = JSON.parse(out);
        expect([code, report.verdict, report.findings[0].code, report.checked]).toEqual([2, "FAIL", "bot_error", []]);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
});

describe("hashes", () => {
  test("a skill whose frontmatter version is not skills[].version fails", () => {
    const skill = SKILL.replace("version: 1.0.0", "version: 1.0.1");
    const r = pr(m => { m.skills[0].sha256 = sha256(skill); patch(m); }, { skill });
    expect(has(r, "skill_version_mismatch", "M")).toBe(true);
    const ok = pr(m => { m.skills[0].sha256 = sha256(skill); m.skills[0].version = "1.0.1"; patch(m); }, { skill });
    expect(noM(ok)).toEqual([]);
  });
  test("a skill file that is not at head fails", () => {
    const r = R.evaluate(source(baseFiles(), { [MP]: json({ ...manifest(), version: "1.0.1" }), [SP]: null }), V);
    expect(has(r, "skill_missing", "M")).toBe(true);
  });
});

describe("version bump class", () => {
  const need = (edit: (m: any) => void, base = manifest()) => { const h = clone(base); edit(h); return R.requiredBump(base, h, V.operationBudgets).level; };
  const cases: [string, (m: any) => void, R.Level][] = [
    ["nothing", () => {}, "none"],
    ["a description", m => { m.description = "Other words."; }, "patch"],
    ["the skill hash", m => { m.skills[0].sha256 = "0".repeat(64); }, "patch"],
    ["a visibility change", m => { m.visibility = "admins"; }, "minor"],
    ["an op removed", m => { m.operations.splice(0, 1); }, "minor"],
    ["a budget lowered", m => { m.operations[0].maxRequestBytes = 1024; }, "minor"],
    ["an op added", m => { m.operations.push({ name: "tinyshop.hours", class: "read" }); }, "major"],
    ["a request budget raised (from the default)", m => { m.operations[0].maxRequestBytes = 8192; }, "major"],
    ["a framing change", m => { m.operations[0].framing = "media"; }, "major"],
    ["a class change", m => { m.operations[0].class = "write"; }, "major"],
    ["an input schema", m => { m.operations[0].input = { type: "object", properties: {}, additionalProperties: false }; }, "major"],
    ["a target", m => { m.operations[0].target = { method: "GET", path: "/menu" }; }, "major"],
    ["the auth block", m => { m.service.auth.secretRef = "MINI_APP_TINYSHOP_OTHER"; }, "major"],
    ["data.context added", m => { m.data = { context: { maxEntries: 4, ceiling: "private" } }; }, "major"],
    ["the approval summary", m => { m.operations[2].approval.summary = ["Order {{preview.total}}"]; }, "major"],
    ["a new permission", m => { m.permissions.push({ kind: "action", label: "Order", description: "Order." }); }, "major"],
    ["events added", m => { m.events = { "miniapp.tinyshop.order@1": { orderId: "string" } }; }, "major"],
  ];
  for (const [why, edit, level] of cases) test(`${why}: ${level}`, () => expect(need(edit)).toBe(level));
  test("a timeout raised is major, lowered is minor", () => {
    const base = manifest(); base.operations[0].timeoutMs = 10000;
    expect(need(m => { m.operations[0].timeoutMs = 20000; }, base)).toBe("major");
    expect(need(m => { m.operations[0].timeoutMs = 5000; }, base)).toBe("minor");
  });
  test("annotation-only input edits (description, title, examples) are a patch; a property named description is not", () => {
    const base = manifest();
    base.operations[0].input = { type: "object", description: "Menu query.", properties: { day: { type: "string", title: "Day", examples: ["mon"] } }, additionalProperties: false };
    expect(need(m => { m.operations[0].input.description = "The menu query."; m.operations[0].input.properties.day.title = "Weekday"; m.operations[0].input.properties.day.examples = ["tue"]; }, base)).toBe("patch");
    expect(need(m => { delete m.operations[0].input.properties.day.examples; m.operations[0].input.$comment = "x"; }, base)).toBe("patch");
    expect(need(m => { m.operations[0].input.properties.description = { type: "string" }; }, base)).toBe("major");
    expect(need(m => { m.operations[0].input.properties.day.maxLength = 3; }, base)).toBe("major");
    expect(need(m => { m.operations[0].input.properties.day.description = "Which day."; }, base)).toBe("patch");
  });
  test("data.context narrowing is minor, widening is major", () => {
    const base = manifest(); base.data = { context: { maxEntries: 16, ceiling: "village" } };
    expect(need(m => { m.data.context.maxEntries = 8; }, base)).toBe("minor");
    expect(need(m => { m.data.context.ceiling = "private"; }, base)).toBe("minor");
    expect(need(m => { m.data.context.maxEntries = 32; }, base)).toBe("major");
    expect(need(m => { m.data.context.ceiling = "public"; }, base)).toBe("major");
  });
  test("bumpOf reads the numeric triple", () => {
    expect([R.bumpOf("1.0.0", "2.0.0"), R.bumpOf("1.0.0", "1.1.0"), R.bumpOf("1.0.9", "1.0.10"), R.bumpOf("1.2.3", "1.2.3"),
      R.bumpOf("1.2.3", "1.2.2"), R.bumpOf("1.2.3", "0.9.9"), R.bumpOf("1.0", "1.0.1")]).toEqual(["major", "minor", "patch", "none", "down", "down", null]);
  });
  test("in a review: too small, not bumped and going down are reported as N, not enforced, until S2 is settled", () => {
    expect(R.BUMP_SEVERITY).toBe("N");
    const addOp = (m: any) => m.operations.push({ name: "tinyshop.hours", class: "read" });
    const small = pr(m => { addOp(m); m.version = "1.1.0"; });
    expect([has(small, "version_bump_too_small", "N"), noM(small), small.verdict]).toEqual([true, [], "PASS"]);
    const ok = pr(m => { addOp(m); m.version = "2.0.0"; });
    expect([has(ok, "version_bump", "N"), noM(ok)]).toEqual([true, []]);
    const same = pr(m => { m.description = "Other."; });
    expect([has(same, "version_not_bumped", "N"), same.verdict]).toEqual([true, "PASS"]);
    const down = pr(m => { m.description = "Other."; m.version = "0.9.0"; });
    expect([has(down, "version_not_monotonic", "N"), down.verdict]).toEqual([true, "PASS"]);
    const fresh = R.evaluate(source({ "mini-apps/catalog.json": CATALOG }, { [MP]: json(manifest()), [SP]: SKILL }), V);
    expect([has(fresh, "version_new_manifest", "N"), noM(fresh)]).toEqual([true, []]);
  });
});

describe("secrets", () => {
  const T = {
    openai: "sk" + "-proj-" + "Ab12Cd34Ef56Gh78Ij90Kl12",
    anthropic: "sk" + "-ant-api03-" + "Ab12Cd34Ef56Gh78Ij90Kl12",
    stripe: "sk" + "_live_" + "Ab12Cd34Ef56Gh78Ij90",
    ghp: "gh" + "p_" + "Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78",
    pat: "github" + "_pat_" + "11ABCDEFG0123456789_abcdefghijklmnop",
    jwt: "ey" + "JhbGciOiJIUzI1NiJ9" + "." + "eyJzdWIiOiJ0ZXN0In0" + "." + "c2lnbmF0dXJlMTIz",
    pem: "-----BEGIN " + "RSA PRIVATE" + " KEY-----",
    pemPlain: "-----BEGIN " + "PRIVATE" + " KEY-----",
    akia: "AK" + "IA" + "ABCDEFGHIJ234567",
    awsSecret: "aws_secret" + "_access_key = " + "Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78St90",
    slack: "xo" + "xb-" + "1234567890-abcdef",
    google: "AI" + "za" + "SyAb12Cd34Ef56Gh78Ij90Kl12Mn34Op56Q",
    password: "pass" + "word=" + "hunter22",
    passwordJson: `"pass` + `word": "hunter22"`,
    bearer: "Authorization: " + "Bearer " + "abcdefghijklmnopqrstuvwxyz012345",
    apiKey: `api_` + `key: "` + "Ab12Cd34Ef56Gh78Ij90" + `"`,
  };
  const want: Record<keyof typeof T, string> = {
    openai: "openai_or_anthropic_key", anthropic: "openai_or_anthropic_key", stripe: "stripe_key", ghp: "github_token", pat: "github_pat",
    jwt: "jwt", pem: "pem_private_key", pemPlain: "pem_private_key", akia: "aws_access_key_id", awsSecret: "aws_secret_access_key",
    slack: "slack_token", google: "google_api_key", password: "password_assignment", passwordJson: "password_field", bearer: "bearer_token",
    apiKey: "credential_assignment",
  };
  for (const key of Object.keys(T) as (keyof typeof T)[]) {
    test(`true positive: ${key}`, () => expect(R.secretHits(`  value ${T[key]} here`)).toContain(want[key]));
  }
  const clean = [
    "Run a risk-assessment-framework-checklist before ordering.",
    "Never ask for the resident's password: the app holds no account.",
    "password = ",
    "The app server holds the Bearer tokens; the box never sees one.",
    `"secretRef": "TINYSHOP_AV_TOKEN"`,
    `"token": "TINYSHOP_AV_TOKEN_NAME"`,
    `apiKey: "credential_assignment",`,
    `"sha256": "${"a".repeat(64)}"`,
    "-----BEGIN PUBLIC KEY-----",
    "eyJ alone is not a token",
    "AKIA123",
    "task-1234567890abcdefghij is a task id",
    "https://api.tinyshop.example.org/menu?date=2026-10-19",
  ];
  for (const text of clean) test(`false positive stays quiet: ${text.slice(0, 40)}`, () => expect(R.secretHits(text)).toEqual([]));

  test("an added line with a secret fails, names the line and never echoes the value", () => {
    const skill = SKILL + `Token: ${T.ghp}\n`;
    const r = pr(m => { m.skills[0].sha256 = sha256(skill); patch(m); }, { skill });
    const hit = r.findings.find(x => x.code === "secret_in_diff")!;
    expect([r.verdict, hit.severity, hit.file, hit.line]).toEqual(["FAIL", "M", SP, skill.split("\n").length - 1]);
    expect(JSON.stringify(r)).not.toContain(T.ghp);
  });
  test("only added lines are scanned; a core file's secret fails too", () => {
    const withOld = { ...baseFiles(), "docs/old.md": `old ${T.akia}\n` };
    const r = R.evaluate(source(withOld, { "docs/old.md": `old ${T.akia}\nnew line\n` }), V);
    expect(has(r, "secret_in_diff")).toBe(false);
    const core = R.evaluate(source(baseFiles(), { "docs/new.md": `${T.pat}\n` }), V);
    expect([core.verdict, has(core, "secret_in_diff", "M")]).toEqual(["FAIL", true]);
  });
  test("a data: URI or a base64 run over 1 KiB in a catalog file fails; 1 KiB does not", () => {
    const uri = "data:" + "image/png;base64,iVBORw0KGgo";
    const big = "QUJD".repeat(257);
    const at = (extra: string) => { const skill = SKILL + extra + "\n"; return pr(m => { m.skills[0].sha256 = sha256(skill); patch(m); }, { skill }); };
    expect(has(at(uri), "data_uri", "M")).toBe(true);
    expect(has(at(big), "base64_blob", "M")).toBe(true);
    expect(has(at(big.slice(0, 1024)), "base64_blob")).toBe(false);
  });
});

describe("data.context", () => {
  const withCtx = (ctx: any, vis = "sandbox") => { const m = manifest(vis); m.data = { context: ctx }; return m; };
  test("no data block: no data finding", () => {
    expect(codes(pr(patch)).filter(c => c.startsWith("data") || c.startsWith("context"))).toEqual([]);
  });
  test("an unchanged private ceiling is quiet", () => {
    const r = pr(patch, { base: withCtx({ maxEntries: 16, ceiling: "private" }) });
    expect(codes(r).filter(c => c.startsWith("context") || c.startsWith("data"))).toEqual([]);
  });
  test("maxEntries over 64 and a data block other than context fail", () => {
    const over = pr(m => { m.data.context.maxEntries = 65; m.version = "2.0.0"; }, { base: withCtx({ maxEntries: 16, ceiling: "private" }) });
    expect(has(over, "context_max_entries", "M")).toBe(true);
    const state = pr(m => { m.data.state = { rows: 1 }; m.version = "2.0.0"; }, { base: withCtx({ maxEntries: 16, ceiling: "private" }) });
    expect(has(state, "data_block_not_allowed", "M")).toBe(true);
  });
  test("a ceiling above the lane's fails (everyone may not declare public)", () => {
    const r = pr(m => { m.data.context.ceiling = "public"; m.version = "2.0.0"; }, { base: withCtx({ maxEntries: 16, ceiling: "village" }, "everyone") });
    expect(has(r, "context_ceiling_over_lane", "M")).toBe(true);
    const sandbox = pr(m => { m.data.context.ceiling = "public"; m.version = "2.0.0"; }, { base: withCtx({ maxEntries: 16, ceiling: "village" }) });
    expect(has(sandbox, "context_ceiling_over_lane")).toBe(false);
  });
  test("a ceiling raised above private needs the human read, even in sandbox; a missing ceiling is S", () => {
    const r = pr(m => { m.data.context.ceiling = "village"; m.version = "2.0.0"; }, { base: withCtx({ maxEntries: 16, ceiling: "private" }) });
    expect([has(r, "context_ceiling_above_private", "S"), r.verdict]).toEqual([true, "NEEDS_HUMAN"]);
    const missing = pr(m => { m.data = { context: { maxEntries: 4 } }; m.version = "2.0.0"; });
    expect(has(missing, "context_ceiling_missing", "S")).toBe(true);
  });
});

describe("approval classes", () => {
  test("a needs-card op with no prepare op fails", () => {
    const r = pr(m => { m.operations[1].class = "read"; m.version = "2.0.0"; });
    expect(has(r, "needs_card_without_prepare", "M")).toBe(true);
    expect(has(pr(patch), "needs_card_without_prepare")).toBe(false);
  });
  test("needs-card -> write is a downgrade: core, NEEDS_HUMAN", () => {
    const r = pr(m => {
      const op = m.operations[2];
      op.class = "write"; delete op.approval; op.timeoutMs = 25000; op.maxRequestBytes = 4096; m.version = "2.0.0";
    });
    expect([noM(r), r.lane, r.verdict, has(r, "needs_card_downgrade", "S")]).toEqual([[], "core", "NEEDS_HUMAN", true]);
  });
  test("needs-card -> read is a downgrade too; an unchanged needs-card op is not", () => {
    const r = pr(m => { const op = m.operations[2]; op.class = "read"; delete op.approval; delete op.timeoutMs; delete op.maxRequestBytes; m.version = "2.0.0"; });
    expect([r.lane, has(r, "needs_card_downgrade")]).toEqual(["core", true]);
    const same = pr(patch);
    expect([has(same, "needs_card_downgrade"), has(same, "needs_card_review"), same.lane]).toEqual([false, false, "sandbox"]);
  });
  test("a needs-card op removed while a card-less op is added: the human read", () => {
    const r = pr(m => { m.operations.splice(2, 1); m.operations.push({ name: "tinyshop.order.place", class: "write" }); m.version = "2.0.0"; });
    expect([has(r, "needs_card_replaced", "S"), r.verdict]).toEqual([true, "NEEDS_HUMAN"]);
  });
  test("a new or changed needs-card op needs the human read, even in sandbox", () => {
    const r = pr(m => { m.operations[2].approval.summary = ["Order"]; m.version = "2.0.0"; });
    expect([has(r, "needs_card_review", "S"), r.verdict]).toEqual([true, "NEEDS_HUMAN"]);
  });
  test("the template render is reported as not run (N), never as a pass", () => {
    const r = pr(patch);
    const t = r.findings.filter(x => x.code === "template_render_not_run");
    expect(t.map(x => x.severity)).toEqual(["N"]);
    expect(t[0].text).toContain("not rendered (not a pass)");
    expect(codes(r).some(c => /render/.test(c) && c !== "template_render_not_run")).toBe(false);
  });
});

describe("conformance: the bot runs P0-5's suite itself (release, L14465)", () => {
  // P0-5's output (ov#422): manifest is the repo-relative path; sha256 is over the exact bytes; not_run is pass: null.
  const out = (h: any, over: any = {}) => Buffer.from(json({ manifest: MP, sha256: sha256(json(h)),
    results: [{ check: "manifest.schema", pass: true, note: "" }, { check: "hygiene.secrets", pass: true, note: "" }], passed: true, ...over }));
  const ran = (over: any = {}, exit: number | null = 0) => (h: any): R.ConformanceRun => ({ status: "ran", exit, bytes: out(h, over) });
  const conf = (r: R.Report) => r.findings.filter(x => x.code.startsWith("conformance")).map(x => [x.code, x.severity]);
  const admins = manifest("admins");
  test("the suite not in the checkout: N conformance_not_available (no S, no M)", () => {
    for (const r of [pr(patch), pr(patch, { base: admins })]) expect([conf(r), r.verdict]).toEqual([[["conformance_not_available", "N"]], "PASS"]);
  });
  test("a passed run for this manifest: quiet, admins PASS", () => {
    const r = pr(patch, { base: admins, conf: ran() });
    expect([conf(r), r.verdict]).toEqual([[], "PASS"]);
  });
  test("another manifest's path or another manifest's bytes (re-serialized included): M", () => {
    expect(conf(pr(patch, { conf: ran({ manifest: "tinyshop@1.0.1" }) }))).toContainEqual(["conformance_wrong_manifest", "M"]);
    expect(conf(pr(patch, { conf: h => ({ status: "ran", exit: 0, bytes: out(h, { sha256: sha256(JSON.stringify(h)) }) }) }))).toContainEqual(["conformance_stale", "M"]);
  });
  test("a failed check: M; passed: true over a failed row, or passed against the exit code: M inconsistent", () => {
    const failed = pr(patch, { conf: ran({ passed: false, results: [{ check: "hygiene.secrets", pass: false, note: "x" }] }, 1) });
    expect([conf(failed), failed.verdict]).toEqual([[["conformance_check_failed", "M"]], "FAIL"]);
    expect(conf(pr(patch, { conf: ran({ results: [{ check: "skills.sha256", pass: false, note: "x" }] }) }))).toContainEqual(["conformance_inconsistent", "M"]);
    expect(conf(pr(patch, { conf: ran({}, 1) }))).toContainEqual(["conformance_inconsistent", "M"]);
    expect(conf(pr(patch, { conf: ran({ passed: false }, 0) }))).toContainEqual(["conformance_inconsistent", "M"]);
  });
  test("required checks not run (pass: null, never a pass): S incomplete, so admins NEEDS_HUMAN and sandbox PASS", () => {
    const notRun = { passed: false, results: [{ check: "manifest.schema", pass: true, note: "" }, { check: "hygiene.secrets", pass: null, note: "no fixtures" }] };
    const a = pr(patch, { base: admins, conf: ran(notRun, 1) });
    expect([conf(a), a.verdict]).toEqual([[["conformance_not_run", "N"], ["conformance_incomplete", "S"]], "NEEDS_HUMAN"]);
    expect(pr(patch, { conf: ran(notRun, 1) }).verdict).toBe("PASS");
  });
  test("the suite's version.bump row is reported, not enforced (S2)", () => {
    const bump = { passed: false, results: [{ check: "manifest.schema", pass: true, note: "" }, { check: "version.bump", pass: false, note: "widened at minor" }] };
    const r = pr(patch, { base: admins, conf: ran(bump, 1) });
    expect([conf(r), noM(r)]).toEqual([[["conformance_bump", "N"], ["conformance_incomplete", "S"]], []]);
  });
  test("a refused run (exit 2, no output) fails closed; unreadable output fails; not at head is a note", () => {
    const refused = pr(patch, { conf: { status: "refused", exit: 2, message: "validator_pin_mismatch" } });
    expect([conf(refused), refused.verdict]).toEqual([[["conformance_refused", "M"]], "FAIL"]);
    expect(conf(pr(patch, { conf: { status: "ran", exit: 0, bytes: Buffer.from("nope") } }))).toEqual([["conformance_unreadable", "M"]]);
    expect(conf(pr(patch, { conf: { status: "not_at_head" } }))).toEqual([["conformance_not_run_here", "N"]]);
  });
});

describe("§5 lane rules", () => {
  test("visibility one step is fine; two steps, or a raise with a major bump, need the human read", () => {
    const one = pr(m => { m.visibility = "admins"; m.version = "1.1.0"; });
    expect([has(one, "visibility_raise_multi_step"), has(one, "visibility_raise_with_major")]).toEqual([false, false]);
    expect(has(pr(m => { m.visibility = "everyone"; m.version = "1.1.0"; }), "visibility_raise_multi_step", "S")).toBe(true);
    const major = pr(m => { m.visibility = "admins"; m.operations.push({ name: "tinyshop.hours", class: "read" }); m.version = "2.0.0"; });
    expect([has(major, "visibility_raise_with_major", "S"), major.verdict]).toEqual([true, "NEEDS_HUMAN"]);
    expect(has(pr(m => { m.visibility = "sandbox"; m.version = "1.1.0"; }, { base: manifest("everyone") }), "visibility_raise_multi_step")).toBe(false);
  });
  test("a new oauth block needs the human read, even in sandbox; an unchanged one does not", () => {
    const oauth = { kind: "mcp", baseUrl: "https://mcp.tinyshop.example.org/mcp", auth: { mode: "oauth", oauth: { resource: "https://mcp.tinyshop.example.org/mcp", scopes: ["menu:read"], discovery: "https://mcp.tinyshop.example.org/.well-known/oauth-authorization-server" } } };
    const r = pr(m => { m.service = oauth; m.version = "2.0.0"; });
    expect([noM(r), has(r, "oauth_review", "S"), r.verdict]).toEqual([[], true, "NEEDS_HUMAN"]);
    const base = manifest(); base.service = oauth;
    expect(has(pr(patch, { base }), "oauth_review")).toBe(false);
  });
  test("an events block: the human read; entering everyone is named so", () => {
    const ev = { "miniapp.tinyshop.order@1": { orderId: "string" } };
    const r = pr(m => { m.events = ev; m.version = "2.0.0"; });
    expect([has(r, "events_review", "S"), r.verdict]).toEqual([true, "NEEDS_HUMAN"]);
    const base = manifest("admins"); base.events = ev;
    expect(has(pr(m => { m.visibility = "everyone"; m.version = "1.1.0"; }, { base }), "events_entering_everyone", "S")).toBe(true);
    expect(has(pr(patch, { base }), "events_review")).toBe(false);
  });
});

describe("the five real manifests, as a no-change pull request", () => {
  const index = JSON.parse(readFileSync(join(REPO, "mini-apps/catalog.json"), "utf8"));
  const real = (path: string) => { try { return readFileSync(join(REPO, path)); } catch { return null; } };
  for (const id of index.apps as string[]) {
    test(`${id}: PASS or NEEDS_HUMAN, no M, never a crash`, () => {
      const r = R.evaluate({ files: [{ path: `mini-apps/${id}/manifest.json`, status: "M", oldMode: "100644", newMode: "100644" }], base: real, head: real, added: () => [], headSha: "e".repeat(40), author: "someone" }, V);
      expect(["PASS", "NEEDS_HUMAN"]).toContain(r.verdict);
      expect([id, noM(r)]).toEqual([id, []]);
      expect(r.lane).not.toBe("core");
      expect(r.checked).toEqual([...R.CHECKED]);
    });
  }
});

// ---- The git layer and the CLI, on a throwaway repository ------------------------------------------
function gitRepo(): { dir: string; run: (...args: string[]) => string; commit: (files: Files, msg: string, modes?: Record<string, string>) => string } {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "mini-apps-review-git-"));
  const run = (...args: string[]) => {
    const r = spawnSync("git", ["-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return String(r.stdout).trim();
  };
  run("init", "-q", "-b", "main");
  const commit = (files: Files, msg: string, modes: Record<string, string> = {}) => {
    for (const [path, body] of Object.entries(files)) {
      const p = join(dir, path);
      if (body === null) { rmSync(p, { force: true }); continue; }
      mkdirSync(dirname(p), { recursive: true });
      rmSync(p, { force: true });
      if (modes[path] === "120000") symlinkSync(body, p); else writeFileSync(p, body);
    }
    run("add", "-A");
    run("commit", "-q", "-m", msg);
    return run("rev-parse", "HEAD");
  };
  return { dir, run, commit };
}
const cli = (args: string[]) => {
  let out = "", err = "";
  const code = R.main(args, { stdout: s => { out += s; }, stderr: s => { err += s; } });
  return { code, report: JSON.parse(out) as R.Report, err };
};

describe("git and the CLI", () => {
  test("end to end: exit 0, the JSON on stdout and in --out, the summary in --summary", () => {
    const g = gitRepo();
    try {
      const base = g.commit(baseFiles(), "base");
      g.run("checkout", "-q", "-b", "pr");
      const skill = SKILL.replace("only.", "only, always.");
      const m = manifest(); m.version = "1.0.1"; m.skills[0].sha256 = sha256(skill);
      const head = g.commit({ [MP]: json(m), [SP]: skill }, "pr");
      // The base branch moves on after the fork: base...head diffs from the merge base, so this is not in the pull request.
      g.run("checkout", "-q", "main");
      const moved = g.commit({ "scripts/other.ts": "x\n" }, "main moves");
      const out = join(g.dir, "..", `${base.slice(0, 8)}-review.json`), md = join(g.dir, "..", `${base.slice(0, 8)}-review.md`);
      const { code, report, err } = cli(["--base", moved, "--head", head, "--author", "someone", "--repo", g.dir, "--out", out, "--summary", md]);
      expect([code, report.verdict, report.lane, report.manifest, report.head]).toEqual([0, "PASS", "sandbox", "tinyshop@1.0.1", head]);
      expect(noM(report)).toEqual([]);
      expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(report);
      expect(readFileSync(md, "utf8")).toContain("**PASS** · lane `sandbox`");
      expect(err).toContain("Mini-apps review");
      rmSync(out); rmSync(md);
    } finally { rmSync(g.dir, { recursive: true, force: true }); }
  });
  test("real git: added-line numbers, the symlink mode, a core path", () => {
    const g = gitRepo();
    try {
      const base = g.commit(baseFiles(), "base");
      const skill = SKILL + "\n" + "pass" + "word=hunter22\n";
      const m = manifest(); m.version = "1.0.1"; m.skills[0].sha256 = sha256(skill);
      const head = g.commit({ [MP]: json(m), [SP]: skill, "mini-apps/tinyshop/README.md": "../../etc" }, "pr", { "mini-apps/tinyshop/README.md": "120000" });
      const r = R.review({ repo: g.dir, base, head, author: "someone" });
      const hit = r.findings.find(f => f.code === "secret_in_diff");
      expect([hit?.file, hit?.line]).toEqual([SP, skill.split("\n").length - 1]);
      expect(has(r, "path_symlink", "M")).toBe(true);
      const files = R.changedFiles(g.dir, base, head);
      expect(files.find(f => f.path.endsWith("README.md"))?.newMode).toBe("120000");
      const core = g.commit({ "install/x.ts": "x\n" }, "core");
      expect(R.review({ repo: g.dir, base, head: core }).lane).toBe("core");
    } finally { rmSync(g.dir, { recursive: true, force: true }); }
  });
  // A stand-in for P0-5's suite at scripts/mini-apps-conformance.ts: it records its argv in its one row.
  const fakeSuite = (exit: number, write: boolean) => [
    'import { readFileSync, writeFileSync } from "node:fs";',
    'import { createHash } from "node:crypto";',
    "const a = process.argv.slice(2);",
    write ? 'writeFileSync(a[a.indexOf("--out") + 1], JSON.stringify({ manifest: a[0], sha256: createHash("sha256").update(readFileSync(a[0])).digest("hex"), results: [{ check: "argv", pass: true, note: a.join(" ") }], passed: true }));' : "",
    `process.exit(${exit});`, "",
  ].join("\n");
  const withSuite = (suite: string | null) => {
    const g = gitRepo();
    const base = g.commit({ ...baseFiles(), ...(suite ? { [R.CONFORMANCE_PATH]: suite } : {}) }, "base");
    const m = manifest(); m.version = "1.0.1"; m.description = "Reworded.";
    const head = g.commit({ [MP]: json(m) }, "pr");
    return { g, base, head };
  };
  test("the suite in the checkout is run on the lane's manifest, always with --base, and judged", () => {
    const { g, base, head } = withSuite(fakeSuite(0, true));
    const saved = join(g.dir, "..", `${base.slice(0, 8)}-conformance`);
    try {
      const r = R.review({ repo: g.dir, base, head, conformanceDir: saved });
      expect([r.verdict, r.findings.filter(f => f.code.startsWith("conformance"))]).toEqual(["PASS", []]);
      const note = JSON.parse(readFileSync(join(saved, "tinyshop.conformance.json"), "utf8")).results[0].note;
      expect(note).toBe(`${MP} --base ${base} --out ${note.split(" --out ")[1]}`);
      // The checkout moved off head: the suite reads the working tree, so it is not run.
      g.run("checkout", "-q", base);
      expect(R.review({ repo: g.dir, base, head }).findings.filter(f => f.code.startsWith("conformance")).map(f => f.code)).toEqual(["conformance_not_run_here"]);
    } finally { rmSync(g.dir, { recursive: true, force: true }); rmSync(saved, { recursive: true, force: true }); }
  });
  test("a suite that refuses (exit 2, no conformance.json) fails closed; no suite at all is N", () => {
    for (const [suite, code, severity] of [[fakeSuite(2, false), "conformance_refused", "M"], [null, "conformance_not_available", "N"]] as const) {
      const { g, base, head } = withSuite(suite);
      try {
        const r = R.review({ repo: g.dir, base, head });
        expect(r.findings.filter(f => f.code.startsWith("conformance")).map(f => [f.code, f.severity])).toEqual([[code, severity]]);
      } finally { rmSync(g.dir, { recursive: true, force: true }); }
    }
  });
  test("a shallow or partial clone cannot be judged: exit 2", () => {
    const { g, base, head } = withSuite(null);
    const shallow = `${g.dir}-shallow`;
    try {
      const c = spawnSync("git", ["clone", "-q", "--depth", "1", `file://${g.dir}`, shallow]);
      expect(c.status).toBe(0);
      const s1 = cli(["--base", "HEAD", "--head", "HEAD", "--repo", shallow]);
      expect([s1.code, s1.report.findings[0].text]).toEqual([2, "shallow_checkout: fetch the full history (fetch-depth: 0)"]);
      g.run("config", "core.repositoryformatversion", "1");
      g.run("config", "extensions.partialClone", "origin");
      const s2 = cli(["--base", base, "--head", head, "--repo", g.dir]);
      expect([s2.code, s2.report.verdict, s2.report.findings[0].code]).toEqual([2, "FAIL", "bot_error"]);
      expect(s2.report.findings[0].text).toMatch(/^partial_clone/);
    } finally { rmSync(g.dir, { recursive: true, force: true }); rmSync(shallow, { recursive: true, force: true }); }
  });
  test("this repository, base = head: an empty diff is core, never a crash", () => {
    const { code, report } = cli(["--base", "HEAD", "--head", "HEAD", "--repo", REPO]);
    expect([code, report.verdict, report.lane]).toEqual([0, "NEEDS_HUMAN", "core"]);
  });
  test("bad usage and a revision that does not resolve: exit 2, FAIL, bot_error", () => {
    for (const args of [[], ["--base", "HEAD"], ["--base", "--head", "HEAD"], ["--base", "HEAD..x", "--head", "HEAD", "--repo", REPO],
      ["--base", "no-such-rev-xyz", "--head", "HEAD", "--repo", REPO], ["--base", "HEAD", "--head", "HEAD", "--author", "a b", "--repo", REPO]]) {
      const { code, report } = cli(args);
      expect([args.join(" "), code, report.verdict, report.findings[0].code]).toEqual([args.join(" "), 2, "FAIL", "bot_error"]);
    }
  });
});

describe("the workflow", () => {
  const wf = readFileSync(join(REPO, ".github/workflows/mini-apps-review.yml"), "utf8");
  test("read-only, pull_request on mini-apps/** and skills/**, no secrets, actions pinned by full sha", () => {
    expect(wf).toMatch(/\npermissions:\n  contents: read\n/);
    expect(wf).toContain('      - "mini-apps/**"\n      - "skills/**"\n');
    const code = wf.split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
    expect(code).not.toMatch(/pull_request_target|secrets\.|GITHUB_TOKEN|github\.token|write-all|: write\b|issues:|pull-requests:/);
    const uses = [...wf.matchAll(/uses: (\S+)/g)].map(m => m[1]);
    expect(uses.length).toBe(3);
    for (const u of uses) expect(u).toMatch(/^[a-z-]+\/[a-z-]+@[0-9a-f]{40}$/);
    expect(wf).toContain("persist-credentials: false");
    expect(wf).toMatch(/GITHUB_STEP_SUMMARY/);
    expect(wf).toContain("name: mini-apps-review");
  });
});
