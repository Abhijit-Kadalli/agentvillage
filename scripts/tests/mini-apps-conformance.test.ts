import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BRIDGE_ERROR_CODES, CHECKS, GENERIC_ERROR_CODES, REQUIRED, Refusal, SECRET_PATTERNS, allowedErrorCode, bumpOf, bumpVerdict,
  loadValidator, main, parseArgs, passedOf, redact, requiredBump, runConformance, secretFindings, secretPattern, show, strictJson,
  summary, withoutAnnotations, type Report, type Result,
} from "../mini-apps-conformance";

// Mini-apps v2 Phase 0, P0-5 (MINIAPPS-PLATFORM-v2-design.md section 5.3 items 1, 4-template, 5): the
// conformance v0 script. Synthetic manifests and fixtures only, in throwaway directories; no network.
//   bun test scripts/tests/mini-apps-conformance.test.ts

const REPO = join(import.meta.dir, "..", "..");
const SCRIPT = join(REPO, "scripts", "mini-apps-conformance.ts");
const shared = createRequire(import.meta.url)("../mini-apps-manifests.cjs");
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
// Escapes are built at run time so this file never holds a literal backslash-u sequence.
const BS = String.fromCharCode(92);
const u = (hex: string) => `${BS}u${hex}`;

const SKILL = "---\nname: acme\nversion: 1.0.0\n---\n# Acme\n";
function acme(): any {
  return {
    manifest: 2, id: "acme", name: "Acme", version: "1.0.0", description: "Synthetic test app.",
    homepage: "https://acme.example", visibility: "sandbox",
    permissions: [{ kind: "read", label: "Read things", description: "Reads synthetic things." }],
    service: { kind: "mcp", baseUrl: "https://acme.example/mcp", auth: { mode: "none" } },
    operations: [
      { name: "acme.lookup", class: "read", target: { tool: "lookup" },
        input: { type: "object", properties: { q: { type: "string" } }, additionalProperties: false }, maxResponseBytes: 4096 },
      { name: "acme.order.prepare", class: "prepare", target: { tool: "quote" }, input: { type: "object" },
        returns: { draftIdPath: "$.draftId", previewPath: "$.approvalPayload", previewMaxBytes: 60000, previewTtlSeconds: 3600 } },
      { name: "acme.order.confirm", class: "needs-card", target: { tool: "place" }, input: { type: "object" },
        maxRequestBytes: 65536, timeoutMs: 60000,
        approval: { prepare: "acme.order.prepare", summary: ["Acme order", "Total: {{preview.total}}"], summaryMaxBytes: 3000 } },
    ],
    skills: [{ name: "acme", version: "1.0.0", sha256: sha256(SKILL), path: "skills/acme/SKILL.md" }],
  };
}
type Catalog = { root: string; path: string; fixtures: string };
/** A throwaway catalog root: mini-apps/<id>/manifest.json, skills/<id>/SKILL.md, and fixture files. */
function catalog(opts: { manifest?: any; text?: string; id?: string; skill?: string; fixtures?: Record<string, string | Buffer> } = {}): Catalog {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "conformance-")));
  const id = opts.id ?? "acme";
  mkdirSync(join(root, "mini-apps", id), { recursive: true });
  mkdirSync(join(root, "skills", "acme"), { recursive: true });
  writeFileSync(join(root, "skills", "acme", "SKILL.md"), opts.skill ?? SKILL);
  const path = join(root, "mini-apps", id, "manifest.json");
  writeFileSync(path, opts.text ?? JSON.stringify(opts.manifest ?? acme(), null, 2) + "\n");
  const fixtures = join(root, "fx");
  mkdirSync(fixtures);
  for (const [rel, body] of Object.entries(opts.fixtures ?? {})) {
    mkdirSync(dirname(join(fixtures, rel)), { recursive: true });
    writeFileSync(join(fixtures, rel), body);
  }
  return { root, path, fixtures };
}
const GOOD_FIXTURES = {
  "acme.lookup/ok.json": JSON.stringify({ items: [{ name: "a" }, { name: "b" }] }),
  "acme.lookup/error-not-found.json": JSON.stringify({ code: "not_found", detail: "No such item." }),
};
function run(c: Catalog, extra: { fixtures?: string | null; base?: string } = {}): Report {
  const fixtures = extra.fixtures === null ? undefined : extra.fixtures ?? c.fixtures;
  return runConformance({ manifest: c.path, fixtures, base: extra.base }, { cwd: c.root });
}
const row = (r: Report, check: string) => r.results.find(x => x.check === check)!;
const cleanup = (c: Catalog) => rmSync(c.root, { recursive: true, force: true });
function withCatalog<T>(opts: Parameters<typeof catalog>[0], fn: (c: Catalog) => T): T {
  const c = catalog(opts);
  try { return fn(c); } finally { cleanup(c); }
}
/** Every report keeps the shape P0-3 reads, and a not_run row always has pass null. */
function invariants(r: Report) {
  expect(Object.keys(r)).toEqual(["manifest", "sha256", "results", "passed"]);
  expect(r.results.map(x => x.check)).toEqual([...CHECKS]);
  for (const x of r.results) {
    expect(Object.keys(x)).toEqual(["check", "pass", "note"]);
    expect([true, false, null]).toContain(x.pass);
    expect(typeof x.note).toBe("string");
  }
  expect(r.passed).toBe(passedOf(r.results));
}

describe("a synthetic app that conforms", () => {
  test("every check that runs passes; the Phase 1 checks and the renderer are not_run; exit 0", () => {
    withCatalog({ fixtures: GOOD_FIXTURES }, c => {
      const r = run(c);
      invariants(r);
      expect(r.manifest).toBe("mini-apps/acme/manifest.json");
      expect(Object.fromEntries(r.results.map(x => [x.check, x.pass]))).toEqual({
        "manifest.validator_pin": true, "manifest.schema": true, "skills.sha256": true, "version.bump": null,
        "service.reachability": null, "service.budgets": null,
        "approval.prepare_pair": true, "approval.summary_render": null, "approval.fake_cp": null,
        "hygiene.fixtures": true, "hygiene.secrets": true, "hygiene.duplicate_keys": true, "hygiene.error_bodies": true,
      });
      expect(row(r, "approval.summary_render").note).toStartWith("renderer_absent");
      expect(row(r, "approval.summary_render").note).toContain("acme.order.confirm (has summary template)");
      expect(r.passed).toBe(true);
      const lines: string[] = [];
      expect(main([c.path, "--fixtures", c.fixtures], { cwd: c.root, print: s => lines.push(s), warn: () => {} })).toBe(0);
      expect(lines.join("\n")).toContain("passed: true");
    });
  });

  test("the default fixture directory is mini-apps/<id>/fixtures/ when present", () => {
    withCatalog({}, c => {
      const dir = join(c.root, "mini-apps", "acme", "fixtures");
      for (const [rel, body] of Object.entries(GOOD_FIXTURES)) {
        mkdirSync(dirname(join(dir, rel)), { recursive: true });
        writeFileSync(join(dir, rel), body);
      }
      expect(run(c, { fixtures: null }).passed).toBe(true);
    });
  });
});

describe("not_run is never a pass", () => {
  const all = (pass: boolean | null): Result[] => CHECKS.map(check => ({ check, pass, note: "" }));
  test("passedOf: a required check that did not run fails the run; an optional one does not", () => {
    expect(passedOf(all(true))).toBe(true);
    expect(passedOf(all(null))).toBe(false);
    expect(passedOf([])).toBe(false);
    // A required check missing from the list is not a pass either.
    expect(passedOf(all(true).filter(x => x.check !== "hygiene.secrets"))).toBe(false);
    expect(passedOf(all(true).filter(x => x.check === "version.bump"))).toBe(false);
    for (const check of CHECKS) {
      const results = all(true).map(x => x.check === check ? { ...x, pass: null } : x);
      expect([check, passedOf(results)]).toEqual([check, !REQUIRED.has(check)]);
      const failed = all(true).map(x => x.check === check ? { ...x, pass: false } : x);
      expect([check, passedOf(failed)]).toEqual([check, false]);
    }
    expect([...REQUIRED].sort()).toEqual(["hygiene.duplicate_keys", "hygiene.error_bodies", "hygiene.fixtures", "hygiene.secrets",
      "manifest.schema", "manifest.validator_pin", "skills.sha256"]);
  });

  test("no fixtures: item 5 is not_run with pass null, and the run fails although nothing failed", () => {
    withCatalog({}, c => {
      const r = run(c, { fixtures: null });
      invariants(r);
      for (const check of ["hygiene.fixtures", "hygiene.secrets", "hygiene.duplicate_keys", "hygiene.error_bodies"]) {
        expect([check, row(r, check).pass]).toEqual([check, null]);
      }
      expect(r.results.some(x => x.pass === false)).toBe(false);
      expect(r.passed).toBe(false);
      expect(main([c.path], { cwd: c.root, print: () => {}, warn: () => {} })).toBe(1);
    });
  });

  test("an empty fixture directory, or no error fixture, is not_run and fails the run", () => {
    withCatalog({}, c => {
      const r = run(c);
      expect(row(r, "hygiene.fixtures")).toEqual({ check: "hygiene.fixtures", pass: null, note: "the fixture directory holds no fixture file" });
      expect(r.passed).toBe(false);
    });
    withCatalog({ fixtures: { "acme.lookup/ok.json": "{}" } }, c => {
      const r = run(c);
      expect(row(r, "hygiene.error_bodies").pass).toBe(null);
      expect(row(r, "hygiene.secrets").pass).toBe(true);
      expect(r.passed).toBe(false);
    });
  });
});

describe("item 1: the manifest, the validator pin, the skill hashes", () => {
  test("sha256 is over the manifest file's exact bytes (CRLF, spacing and key order all count)", () => {
    const text = JSON.stringify(acme(), null, 4).replace(/\n/g, "\r\n") + "  \r\n";
    withCatalog({ text, fixtures: GOOD_FIXTURES }, c => {
      const r = run(c);
      const bytes = readFileSync(c.path);
      expect(r.sha256).toBe(sha256(bytes));
      expect(r.sha256).not.toBe(sha256(JSON.stringify(JSON.parse(bytes.toString("utf8")))));
      expect(r.sha256).not.toBe(sha256(JSON.stringify(acme(), null, 2) + "\n"));
      expect(r.passed).toBe(true);
    });
  });

  test("schema: an unknown key, an invalid JSON file, a duplicate key and an id that is not its directory each fail", () => {
    const cases: [string, Parameters<typeof catalog>[0], string][] = [
      ["unknown key", { manifest: { ...acme(), restricted: true } }, "/restricted additionalProperties"],
      ["not JSON", { text: "{\"manifest\": 2,}" }, "not strict JSON"],
      ["duplicate key", { text: JSON.stringify(acme()).replace("{\"manifest\":2,", "{\"manifest\":2,\"visibility\":\"everyone\",") }, "duplicate key /visibility"],
      ["id is not its directory", { id: "other" }, "/id is not its directory name"],
      ["a BOM", { text: String.fromCharCode(0xfeff) + JSON.stringify(acme()) }, "not strict JSON"],
    ];
    for (const [why, opts, want] of cases) {
      withCatalog({ ...opts, fixtures: GOOD_FIXTURES }, c => {
        const r = run(c);
        invariants(r);
        expect([why, row(r, "manifest.schema").pass, row(r, "manifest.schema").note.includes(want)]).toEqual([why, false, true]);
        expect(r.passed).toBe(false);
      });
    }
    withCatalog({ fixtures: GOOD_FIXTURES }, c => {
      writeFileSync(c.path, Buffer.from([0x7b, 0xff, 0x7d]));
      expect(row(run(c), "manifest.schema")).toEqual({ check: "manifest.schema", pass: false, note: "not UTF-8" });
    });
    // JSON.parse alone would keep the last "visibility" and call the manifest valid.
    expect(shared.validateManifest(JSON.parse(JSON.stringify(acme()).replace("{\"manifest\":2,", "{\"manifest\":2,\"visibility\":\"everyone\","))).ok).toBe(true);
  });

  test("skills: a wrong hash, a missing file and a symlinked SKILL.md each fail", () => {
    withCatalog({ skill: SKILL + "edited\n", fixtures: GOOD_FIXTURES }, c => {
      const r = row(run(c), "skills.sha256");
      expect(r.pass).toBe(false);
      expect(r.note).toContain(`skills/acme/SKILL.md sha256 is ${sha256(SKILL + "edited\n")}`);
    });
    withCatalog({ fixtures: GOOD_FIXTURES }, c => {
      rmSync(join(c.root, "skills", "acme", "SKILL.md"));
      expect(row(run(c), "skills.sha256")).toEqual({ check: "skills.sha256", pass: false, note: "skills/acme/SKILL.md missing" });
    });
    withCatalog({ fixtures: GOOD_FIXTURES }, c => {
      const real = join(c.root, "elsewhere.md");
      writeFileSync(real, SKILL);
      rmSync(join(c.root, "skills", "acme", "SKILL.md"));
      symlinkSync(real, join(c.root, "skills", "acme", "SKILL.md"));
      expect(row(run(c), "skills.sha256").note).toBe("skills/acme/SKILL.md is not a regular file");
    });
  });

  test("skills: a skill directory symlinked outside the repo fails; one symlinked inside the repo is followed", () => {
    // skills/acme -> a directory outside the catalog root that holds a correct SKILL.md (the guard at realpath).
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "conformance-outside-")));
    try {
      writeFileSync(join(outside, "SKILL.md"), SKILL);
      withCatalog({ fixtures: GOOD_FIXTURES }, c => {
        rmSync(join(c.root, "skills", "acme"), { recursive: true });
        symlinkSync(outside, join(c.root, "skills", "acme"));
        const r = run(c);
        expect(row(r, "skills.sha256")).toEqual({ check: "skills.sha256", pass: false, note: "skills/acme/SKILL.md resolves outside the repo" });
        expect(r.passed).toBe(false);
      });
    } finally { rmSync(outside, { recursive: true, force: true }); }
    withCatalog({ fixtures: GOOD_FIXTURES }, c => {
      renameSync(join(c.root, "skills", "acme"), join(c.root, "skills", "acme-real"));
      symlinkSync(join(c.root, "skills", "acme-real"), join(c.root, "skills", "acme"));
      expect(row(run(c), "skills.sha256")).toEqual({ check: "skills.sha256", pass: true, note: "matches: skills/acme/SKILL.md" });
    });
  });

  test("the manifest: a symlinked manifest.json refuses; a manifest over 1 MB fails, one of exactly 1 MB is read", () => {
    withCatalog({ fixtures: GOOD_FIXTURES }, c => {
      const real = join(c.root, "real-manifest.json");
      renameSync(c.path, real);
      symlinkSync(real, c.path);
      let reason = "";
      try { run(c); } catch (e) { reason = e instanceof Refusal ? e.reason : "other"; }
      expect(reason).toBe("manifest_not_a_regular_file");
    });
    const sized = (n: number) => { const head = "{\"pad\":\"", tail = "\"}"; return head + "a".repeat(n - head.length - tail.length) + tail; };
    withCatalog({ text: sized((1 << 20) + 1), fixtures: GOOD_FIXTURES }, c => {
      expect(statSync(c.path).size).toBe((1 << 20) + 1);
      expect(row(run(c), "manifest.schema")).toEqual({ check: "manifest.schema", pass: false, note: "over 1048576 bytes" });
    });
    withCatalog({ text: sized(1 << 20), fixtures: GOOD_FIXTURES }, c => {
      expect(statSync(c.path).size).toBe(1 << 20);
      const r = row(run(c), "manifest.schema");
      expect([r.pass, r.note.startsWith("over "), r.note.includes("/pad")]).toEqual([false, false, true]);
    });
  });

  /** A tool root holding copies of the script, the validator, the schema and the pins. */
  function toolCopy(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "conformance-tool-")));
    for (const rel of ["scripts/mini-apps-conformance.ts", "scripts/mini-apps-manifests.cjs", "mini-apps/manifest.v2.schema.json", "mini-apps/manifests.pins.json"]) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      copyFileSync(join(REPO, rel), join(dir, rel));
    }
    return dir;
  }
  test("fail closed: a validator, schema or pins file that is not the pinned one refuses (exit 2, no conformance.json)", () => {
    const cases: [string, (dir: string) => void, string][] = [
      ["an edited validator", d => writeFileSync(join(d, "scripts/mini-apps-manifests.cjs"), readFileSync(join(d, "scripts/mini-apps-manifests.cjs"), "utf8") + "\n// x\n"), "validator_sha_mismatch"],
      ["an edited schema file", d => writeFileSync(join(d, "mini-apps/manifest.v2.schema.json"), "{}\n"), "schema_sha_mismatch"],
      ["a pin naming other bytes", d => writeFileSync(join(d, "mini-apps/manifests.pins.json"), JSON.stringify({ manifest: 2, sha256: { module: "0".repeat(64), schema: "0".repeat(64) } })), "validator_sha_mismatch"],
      ["a malformed pins file", d => writeFileSync(join(d, "mini-apps/manifests.pins.json"), JSON.stringify({ sha256: { module: "x" } })), "pins_malformed"],
      ["no pins file", d => rmSync(join(d, "mini-apps/manifests.pins.json")), "pins_missing"],
      ["no validator", d => rmSync(join(d, "scripts/mini-apps-manifests.cjs")), "validator_missing"],
      // A symlink to the very same (pinned) bytes is still refused: the tool reads only regular files.
      ["a symlinked pins file", d => { renameSync(join(d, "mini-apps/manifests.pins.json"), join(d, "pins-real.json")); symlinkSync(join(d, "pins-real.json"), join(d, "mini-apps/manifests.pins.json")); }, "pins_not_a_regular_file"],
      ["a symlinked validator", d => { renameSync(join(d, "scripts/mini-apps-manifests.cjs"), join(d, "validator-real.cjs")); symlinkSync(join(d, "validator-real.cjs"), join(d, "scripts/mini-apps-manifests.cjs")); }, "validator_not_a_regular_file"],
    ];
    withCatalog({ fixtures: GOOD_FIXTURES }, c => {
      for (const [why, plant, reason] of cases) {
        const tool = toolCopy();
        try {
          expect(loadValidator(tool).moduleSha).toBe(sha256(readFileSync(join(REPO, "scripts/mini-apps-manifests.cjs"))));
          plant(tool);
          let refused = "";
          try { loadValidator(tool); } catch (e) { refused = e instanceof Refusal ? e.reason : "other"; }
          expect([why, refused]).toEqual([why, reason]);
          const out = join(c.root, "conformance.json");
          const warned: string[] = [];
          expect([why, main([c.path, "--fixtures", c.fixtures, "--out", out], { cwd: c.root, toolRoot: tool, print: () => {}, warn: s => warned.push(s) })]).toEqual([why, 2]);
          expect(warned.join("")).toContain(`refused: ${reason}`);
          expect(() => readFileSync(out)).toThrow();
        } finally { rmSync(tool, { recursive: true, force: true }); }
      }
      // The same through a real process: the copied script refuses with its own edited validator beside it.
      const tool = toolCopy();
      try {
        writeFileSync(join(tool, "scripts/mini-apps-manifests.cjs"), readFileSync(join(tool, "scripts/mini-apps-manifests.cjs"), "utf8").replace("const MAX_ERRORS = 32;", "const MAX_ERRORS = 0;"));
        const p = spawnSync("bun", [join(tool, "scripts/mini-apps-conformance.ts"), c.path, "--fixtures", c.fixtures], { cwd: c.root, encoding: "utf8" });
        expect([p.status, p.stderr.includes("refused: validator_sha_mismatch")]).toEqual([2, true]);
      } finally { rmSync(tool, { recursive: true, force: true }); }
    });
  });

  test("the validator it runs is P0-1's module, compiled from the pinned bytes", () => {
    const { validator, moduleSha } = loadValidator(REPO);
    const pins = JSON.parse(readFileSync(join(REPO, "mini-apps/manifests.pins.json"), "utf8"));
    expect(moduleSha).toBe(pins.sha256.module);
    for (const value of [acme(), { ...acme(), restricted: true }, { ...acme(), id: "rolodex" }, {}]) {
      expect(validator.validateManifest(value)).toEqual(JSON.parse(JSON.stringify(shared.validateManifest(value))));
    }
    expect(validator.operationBudgets({ name: "x.y", class: "read" })).toEqual({ ...shared.operationBudgets({ name: "x.y", class: "read" }) });
  });
});

describe("item 1: the version bump class", () => {
  const budgets = shared.operationBudgets;
  const verdict = (from: any, to: any) => bumpVerdict(requiredBump(from, to, budgets), from.version, to.version);
  const edit = (version: string, change: (m: any) => void) => { const m = acme(); m.version = version; change(m); return m; };
  test("bumpOf orders semver triples", () => {
    expect(bumpOf("1.0.0", "2.0.0")).toBe("major");
    expect(bumpOf("1.0.0", "1.1.0")).toBe("minor");
    expect(bumpOf("1.0.0", "1.0.1")).toBe("patch");
    expect(bumpOf("1.0.0", "1.0.0")).toBe("none");
    expect(bumpOf("1.0.0-rc1", "1.0.0")).toBe("prerelease");
    expect(bumpOf("1.2.0", "1.1.9")).toBe("downgrade");
    expect(bumpOf("1.10.0", "1.9.0")).toBe("downgrade");
    expect(bumpOf("1.0", "1.0.1")).toBe("invalid");
  });
  test("prerelease precedence (semver section 11): a downgrade, 1.0.0 -> 1.0.0-rc.1 included, is \"downgrade\" and fails", () => {
    const downs: [string, string][] = [["1.0.0", "1.0.0-rc.1"], ["1.0.0", "1.0.0-rc1"], ["1.0.0-rc.2", "1.0.0-rc.1"], ["1.0.0-rc.10", "1.0.0-rc.9"],
      ["1.0.0-alpha.beta", "1.0.0-alpha.1"], ["1.0.0-alpha.1", "1.0.0-alpha"], ["1.0.0-beta", "1.0.0-alpha"], ["2.0.0", "2.0.0-rc.1"]];
    for (const [from, to] of downs) {
      expect([from, to, bumpOf(from, to)]).toEqual([from, to, "downgrade"]);
      const v = verdict(edit(from, () => {}), edit(to, m => { m.description = "New copy."; }));
      expect([from, to, v.pass, v.note.startsWith(`${from} -> ${to} is downgrade`)]).toEqual([from, to, false, true]);
    }
    const ups: [string, string][] = [["1.0.0-rc.1", "1.0.0"], ["1.0.0-rc.1", "1.0.0-rc.2"], ["1.0.0-rc.9", "1.0.0-rc.10"],
      ["1.0.0-alpha", "1.0.0-alpha.1"], ["1.0.0-alpha.1", "1.0.0-alpha.beta"], ["1.0.0-alpha", "1.0.0-beta"]];
    for (const [from, to] of ups) {
      expect([from, to, bumpOf(from, to)]).toEqual([from, to, "prerelease"]);
      expect([from, to, verdict(edit(from, () => {}), edit(to, m => { m.description = "New copy."; })).pass]).toEqual([from, to, true]);
    }
    expect(bumpOf("1.0.0-rc.1", "1.0.0-rc.1")).toBe("none");
    expect(bumpOf("1.0.0", "1.0.1-rc.1")).toBe("patch");
  });
  test("an input-schema edit of annotations only (description, title, examples, $comment) is a patch; any other input edit is major", () => {
    const annotations: [string, (m: any) => void][] = [
      ["a property description", m => { m.operations[0].input.properties.q.description = "The query."; }],
      ["a schema title", m => { m.operations[0].input.title = "Lookup"; }],
      ["examples", m => { m.operations[0].input.properties.q.examples = ["latte"]; }],
      ["a $comment", m => { m.operations[0].input.$comment = "from the upstream tool"; }],
      ["nested, inside items / anyOf / $defs", m => {
        m.operations[1].input = { type: "object", properties: { lines: { type: "array", items: { type: "string", description: "one line" } } },
          anyOf: [{ required: ["lines"], title: "with lines" }], $defs: { x: { type: "string", description: "x" } } };
      }],
    ];
    const base = () => {
      const m = acme();
      m.operations[1].input = { type: "object", properties: { lines: { type: "array", items: { type: "string" } } }, anyOf: [{ required: ["lines"] }], $defs: { x: { type: "string" } } };
      return m;
    };
    const ed = (version: string, change: (m: any) => void) => { const m = base(); m.version = version; change(m); return m; };
    for (const [why, change] of annotations) {
      const patch = verdict(base(), ed("1.0.1", change));
      expect([why, patch.pass, patch.note.includes("input annotations changed")]).toEqual([why, true, true]);
      expect([why, requiredBump(base(), ed("1.0.1", change), budgets).level]).toEqual([why, "patch"]);
      expect([why, verdict(base(), ed("1.0.0", change)).pass]).toEqual([why, false]);
    }
    const real: [string, (m: any) => void][] = [
      ["a type changed", m => { m.operations[0].input.properties.q.type = "number"; }],
      ["a property NAMED description added", m => { m.operations[0].input.properties.description = { type: "string" }; }],
      ["a property removed", m => { m.operations[0].input.properties = {}; }],
      ["a default added (not an annotation here)", m => { m.operations[0].input.properties.q.default = "x"; }],
      ["required changed", m => { m.operations[0].input.required = ["q"]; }],
      ["enum changed", m => { m.operations[0].input.properties.q.enum = ["a"]; }],
      ["a description under a keyword v0 does not walk", m => { m.operations[0].input["x-upstream"] = { description: "y" }; }],
      ["additionalProperties opened", m => { m.operations[0].input.additionalProperties = true; }],
    ];
    for (const [why, change] of real) {
      const minor = verdict(acme(), edit("1.1.0", change));
      expect([why, minor.pass, minor.note.includes("major: acme.lookup input changed")]).toEqual([why, false, true]);
      expect([why, verdict(acme(), edit("2.0.0", change)).pass]).toEqual([why, true]);
    }
    // withoutAnnotations keeps a property named like a keyword, and drops only keyword positions.
    expect(withoutAnnotations({ type: "object", description: "d", properties: { description: { type: "string", title: "t" } }, required: ["description"] }))
      .toEqual({ type: "object", properties: { description: { type: "string" } }, required: ["description"] });
  });
  test("a widening needs a major bump: each one fails at minor and passes at major", () => {
    const widenings: [string, (m: any) => void][] = [
      ["an op added", m => m.operations.push({ name: "acme.extra", class: "read" })],
      ["a budget raised", m => { m.operations[0].maxResponseBytes = 8192; }],
      ["a default budget raised", m => { m.operations[1].maxRequestBytes = 8192; }],
      ["a timeout raised", m => { m.operations[1].timeoutMs = 25001; }],
      ["a class changed", m => { m.operations[0].class = "write"; }],
      ["an input changed (even a tightening: v0 cannot prove a schema tighter)", m => { m.operations[0].input.properties.q.maxLength = 10; }],
      ["a target changed", m => { m.operations[0].target.tool = "other"; }],
      ["framing changed", m => { m.operations[0].framing = "media"; }],
      ["the summary template changed", m => { m.operations[2].approval.summary[1] = "Sum: {{preview.total}}"; }],
      ["summaryMaxBytes changed", m => { m.operations[2].approval.summaryMaxBytes = 2999; }],
      ["previewMaxBytes raised", m => { m.operations[1].returns.previewMaxBytes = 65536; }],
      ["auth changed", m => { m.service.auth = { mode: "app-token", secretRef: "ACME_KEY" }; }],
      ["baseUrl changed", m => { m.service.baseUrl = "https://other.example/mcp"; }],
      ["data added", m => { m.data = { context: { maxEntries: 4 } }; }],
      ["an event added", m => { m.events = { "miniapp.acme.done@1": { orderId: "string" } }; }],
      ["owner changed", m => { m.owner = { github: "someone" }; }],
    ];
    for (const [why, change] of widenings) {
      const minor = verdict(acme(), edit("1.1.0", change));
      const major = verdict(acme(), edit("2.0.0", change));
      expect([why, minor.pass, minor.note.startsWith("needs a major bump")]).toEqual([why, false, true]);
      expect([why, major.pass]).toEqual([why, true]);
    }
  });
  test("data widened needs major; copy, a lowered budget and a removed op need only a patch", () => {
    const withData = (m: any, ctx: any) => { m.data = { context: ctx }; return m; };
    expect(verdict(withData(acme(), { maxEntries: 4 }), withData(edit("1.1.0", () => {}), { maxEntries: 8 })).pass).toBe(false);
    expect(verdict(withData(acme(), { maxEntries: 4 }), withData(edit("1.1.0", () => {}), { maxEntries: 4, ceiling: "village" })).pass).toBe(false);
    expect(verdict(withData(acme(), { maxEntries: 8 }), withData(edit("1.0.1", () => {}), { maxEntries: 4 })).pass).toBe(true);
    const narrowings: [string, (m: any) => void][] = [
      ["description", m => { m.description = "New copy."; }],
      ["a budget lowered", m => { m.operations[0].maxResponseBytes = 2048; }],
      ["an op removed", m => { m.operations.splice(0, 1); }],
      ["permissions copy", m => { m.permissions[0].description = "Reads things."; }],
      ["the skill hash", m => { m.skills[0].sha256 = "a".repeat(64); }],
      ["visibility", m => { m.visibility = "admins"; }],
    ];
    for (const [why, change] of narrowings) {
      expect([why, verdict(acme(), edit("1.0.1", change)).pass]).toEqual([why, true]);
      const none = verdict(acme(), edit("1.0.0", change));
      expect([why, none.pass, none.note.startsWith("the manifest changed but the version did not")]).toEqual([why, false, true]);
    }
  });
  test("unchanged passes at any non-downgrade; a downgrade and a changed id fail", () => {
    expect(verdict(acme(), acme())).toEqual({ check: "version.bump", pass: true, note: "no change since the base; 1.0.0 -> 1.0.0 is none" });
    expect(verdict(acme(), edit("1.0.1", () => {})).pass).toBe(true);
    expect(verdict(edit("1.2.0", () => {}), edit("1.1.0", m => { m.description = "x."; })).pass).toBe(false);
    expect(verdict(acme(), edit("2.0.0", m => { m.id = "acme2"; })).pass).toBe(false);
    // Whitespace and key order are not a change (the comparison is canonical).
    const reordered = Object.fromEntries(Object.entries(acme()).reverse());
    expect(requiredBump(acme(), reordered, budgets)).toEqual({ level: "none", reasons: [] });
  });

  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const g = (root: string, ...args: string[]) => {
    const p = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: root, env: gitEnv, encoding: "utf8" });
    if (p.status !== 0) throw new Error(`git ${args[0]}: ${p.stderr}`);
    return p.stdout;
  };
  test("--base: the diff against a local git ref (new, unchanged, widened at minor, widened at major, v1 base, bad refs)", () => {
    withCatalog({ fixtures: GOOD_FIXTURES }, c => {
      g(c.root, "init", "-q");
      g(c.root, "add", "skills");
      g(c.root, "commit", "-q", "-m", "skill only");
      expect(row(run(c, { base: "HEAD" }), "version.bump").note).toStartWith("a new manifest: none at HEAD");
      g(c.root, "add", "mini-apps");
      g(c.root, "commit", "-q", "-m", "manifest");
      expect(row(run(c, { base: "HEAD" }), "version.bump").pass).toBe(true);
      writeFileSync(c.path, JSON.stringify(edit("1.1.0", m => m.operations.push({ name: "acme.extra", class: "read" }))));
      const minor = run(c, { base: "HEAD" });
      expect([row(minor, "version.bump").pass, row(minor, "version.bump").note]).toEqual([false,
        "needs a major bump, 1.0.0 -> 1.1.0 is minor (major: operation acme.extra added)"]);
      expect(minor.passed).toBe(false);
      writeFileSync(c.path, JSON.stringify(edit("2.0.0", m => m.operations.push({ name: "acme.extra", class: "read" }))));
      expect(row(run(c, { base: "HEAD" }), "version.bump").pass).toBe(true);
      expect(run(c, { base: "HEAD" }).passed).toBe(true);
      // A v1 base (P0-1's own conversion) has no bump class: not_run, never a pass.
      writeFileSync(c.path, JSON.stringify({ id: "acme", version: "0.9.0", operations: ["mini-app.read"] }));
      g(c.root, "commit", "-q", "-am", "v1");
      writeFileSync(c.path, JSON.stringify(acme()));
      expect(row(run(c, { base: "HEAD" }), "version.bump").pass).toBe(null);
      // A v2 base the validator rejects: not_run, never a pass.
      writeFileSync(c.path, JSON.stringify({ ...acme(), restricted: true }));
      g(c.root, "commit", "-q", "-am", "an invalid v2 base");
      writeFileSync(c.path, JSON.stringify(acme()));
      expect(row(run(c, { base: "HEAD" }), "version.bump")).toEqual({ check: "version.bump", pass: null, note: "the manifest at HEAD is not a valid v2 manifest" });
      for (const bad of ["no-such-ref", "-p", "HEAD:mini-apps", "a b", "HEAD..HEAD~1", ""]) {
        let reason = "";
        try { run(c, { base: bad }); } catch (e) { reason = e instanceof Refusal ? e.reason : "other"; }
        expect([bad, reason === "bad_base_ref" || reason === "base_ref_unknown"]).toEqual([bad, true]);
      }
    });
    withCatalog({ fixtures: GOOD_FIXTURES }, c => {
      let reason = "";
      try { run(c, { base: "HEAD" }); } catch (e) { reason = (e as Refusal).reason; }
      expect(reason).toBe("base_needs_a_git_checkout");
    });
  });

  test("--base: the manifest path reaches git as a literal path, never pathspec magic (a checkout dir named \":(glob)c\")", () => {
    const top = realpathSync(mkdtempSync(join(tmpdir(), "conformance-magic-")));
    try {
      const root = join(top, ":(glob)c");
      mkdirSync(join(root, "mini-apps", "acme"), { recursive: true });
      mkdirSync(join(root, "skills", "acme"), { recursive: true });
      writeFileSync(join(root, "skills", "acme", "SKILL.md"), SKILL);
      writeFileSync(join(root, "mini-apps", "acme", "manifest.json"), JSON.stringify(acme(), null, 2) + "\n");
      g(top, "init", "-q");
      g(top, "add", "-A");
      g(top, "commit", "-q", "-m", "a catalog in a subdirectory");
      const r = runConformance({ manifest: join(root, "mini-apps", "acme", "manifest.json"), base: "HEAD" }, { cwd: root });
      expect(row(r, "version.bump")).toEqual({ check: "version.bump", pass: true, note: "no change since the base; 1.0.0 -> 1.0.0 is none" });
    } finally { rmSync(top, { recursive: true, force: true }); }
  });

  test("--base in a partial clone: a base blob that is not local REFUSES (exit 2), never \"a new manifest\", never a pass", () => {
    withCatalog({ fixtures: GOOD_FIXTURES }, c => {
      g(c.root, "init", "-q");
      g(c.root, "config", "uploadpack.allowFilter", "true");
      g(c.root, "add", "skills");
      g(c.root, "commit", "-q", "-m", "skill only");
      g(c.root, "add", "mini-apps");
      g(c.root, "commit", "-q", "-m", "acme 1.0.0");
      // A budget widened at a minor bump: a full clone fails it.
      writeFileSync(c.path, JSON.stringify(edit("1.1.0", m => { m.operations[0].maxResponseBytes = 8192; }), null, 2) + "\n");
      g(c.root, "commit", "-q", "-am", "acme 1.1.0, widened");
      const full = run(c, { base: "HEAD~1" });
      expect([row(full, "version.bump").pass, row(full, "version.bump").note]).toEqual([false,
        "needs a major bump, 1.0.0 -> 1.1.0 is minor (major: acme.lookup maxResponseBytes raised 4096 -> 8192)"]);
      const clones = realpathSync(mkdtempSync(join(tmpdir(), "conformance-clone-")));
      try {
        for (const filter of ["blob:none", "tree:0"]) {
          const dir = join(clones, filter.replace(":", "-"));
          g(clones, "clone", "-q", `--filter=${filter}`, `file://${c.root}`, dir);
          const manifest = join(dir, "mini-apps", "acme", "manifest.json");
          // The precondition: the base's manifest blob really is not in the clone's object store.
          const probe = spawnSync("git", ["cat-file", "-e", "HEAD~1:mini-apps/acme/manifest.json"], { cwd: dir, env: { ...gitEnv, GIT_NO_LAZY_FETCH: "1" } });
          expect([filter, probe.status === 0]).toEqual([filter, false]);
          const want = filter === "blob:none" ? "base_blob_missing" : "base_tree_unreadable";
          let reason = "";
          try { runConformance({ manifest, fixtures: c.fixtures, base: "HEAD~1" }, { cwd: dir }); } catch (e) { reason = e instanceof Refusal ? e.reason : `other ${e}`; }
          expect([filter, reason]).toEqual([filter, want]);
          // The CLI: exit 2, from a real process, and no conformance.json.
          const out = join(clones, `${filter.replace(":", "-")}.json`);
          const p = spawnSync("bun", [SCRIPT, manifest, "--fixtures", c.fixtures, "--base", "HEAD~1", "--out", out], { cwd: dir, encoding: "utf8" });
          expect([filter, p.status, p.stderr.includes(`refused: ${want}`), existsSync(out)]).toEqual([filter, 2, true, false]);
          // The clone fetched nothing on the tool's behalf: the blob is still not local.
          expect([filter, spawnSync("git", ["cat-file", "-e", "HEAD~1:mini-apps/acme/manifest.json"], { cwd: dir, env: { ...gitEnv, GIT_NO_LAZY_FETCH: "1" } }).status === 0]).toEqual([filter, false]);
        }
        // A path is literal, never a pathspec glob: mini-apps/[a]cme/ is not mini-apps/acme/ (no refusal).
        const globbed = join(clones, "blob-none", "mini-apps", "[a]cme");
        mkdirSync(globbed);
        copyFileSync(join(clones, "blob-none", "mini-apps", "acme", "manifest.json"), join(globbed, "manifest.json"));
        const literal = runConformance({ manifest: join(globbed, "manifest.json"), fixtures: c.fixtures, base: "HEAD~1" }, { cwd: join(clones, "blob-none") });
        expect(row(literal, "version.bump")).toEqual({ check: "version.bump", pass: null, note: "the manifest is not a valid v2 manifest" });
        // In the blob-less clone a path that is absent at the base is still told apart: a new manifest.
        const manifest = join(clones, "blob-none", "mini-apps", "acme", "manifest.json");
        const fresh = runConformance({ manifest, fixtures: c.fixtures, base: "HEAD~2" }, { cwd: join(clones, "blob-none") });
        expect(row(fresh, "version.bump").note).toStartWith("a new manifest: none at HEAD~2");
      } finally { rmSync(clones, { recursive: true, force: true }); }
    });
  });
});

describe("item 4: approval, statically", () => {
  test("every needs-card op names a prepare-class op; a missing, unknown or read-class prepare fails", () => {
    const cases: [string, (m: any) => void, string][] = [
      ["unknown prepare", m => { m.operations[2].approval.prepare = "acme.order.nope"; }, "is not an operation of this manifest"],
      ["a read named as prepare", m => { m.operations[2].approval.prepare = "acme.lookup"; }, "is class read, not prepare"],
      ["no approval", m => { delete m.operations[2].approval; }, "no approval.prepare"],
    ];
    for (const [why, change, want] of cases) {
      const m = acme();
      change(m);
      withCatalog({ manifest: m, fixtures: GOOD_FIXTURES }, c => {
        const r = run(c);
        expect([why, row(r, "approval.prepare_pair").pass, row(r, "approval.prepare_pair").note.includes(want)]).toEqual([why, false, true]);
        expect(r.passed).toBe(false);
      });
    }
    const none = acme();
    none.operations = none.operations.slice(0, 1);
    withCatalog({ manifest: none, fixtures: GOOD_FIXTURES }, c => {
      expect(row(run(c), "approval.prepare_pair")).toEqual({ check: "approval.prepare_pair", pass: true, note: "no needs-card operation" });
      expect(row(run(c), "approval.summary_render").note).toEndWith("; no needs-card op");
    });
  });
  test("the summary render is not_run renderer_absent: no section 3.2 renderer in the repo, and v0 renders nothing", () => {
    withCatalog({ fixtures: GOOD_FIXTURES }, c => {
      const r = row(run(c), "approval.summary_render");
      expect(r.pass).toBe(null);
      expect(r.note).toStartWith("renderer_absent: ");
    });
    const scripts = readFileSync(SCRIPT, "utf8");
    expect(scripts.includes("{{#each")).toBe(false);
  });
});

describe("item 5: strict JSON and duplicate keys (a raw-text scan; JSON.parse hides them)", () => {
  const dups = (text: string) => {
    const r = strictJson(text);
    if (!r.ok) throw new Error(r.error);
    return r.duplicates.map(d => show([...d.at, d.key]));
  };
  test("top level, nested, inside arrays, and only within one object", () => {
    expect(dups("{\"a\":1,\"a\":2}")).toEqual(["/a"]);
    expect(dups("{\"x\":{\"k\":1,\"j\":{\"k\":0},\"k\":2}}")).toEqual(["/x/k"]);
    expect(dups("[{\"k\":1},{\"k\":2}]")).toEqual([]);
    expect(dups("[0,{\"k\":1,\"k\":2}]")).toEqual(["/1/k"]);
    expect(dups("{\"a\":{\"k\":1},\"b\":{\"k\":1}}")).toEqual([]);
    expect(dups("{\"A\":1,\"a\":2}")).toEqual([]);
    expect(dups("{\"a\":1,\"b\":{\"c\":[{\"d\":1,\"d\":1}]},\"a\":3}")).toEqual(["/b/c/0/d", "/a"]);
    expect(dups("{\"a/b\":1,\"a/b\":2}")).toEqual(["/a~1b"]);
    // JSON.parse keeps one of them silently.
    expect(JSON.parse("{\"a\":1,\"a\":2}")).toEqual({ a: 2 });
  });
  test("escaped keys are compared after decoding", () => {
    expect(dups(`{"a":1,"${u("0061")}":2}`)).toEqual(["/a"]);
    expect(dups(`{"${u("0041")}b":1,"Ab":2}`)).toEqual(["/Ab"]);
    expect(dups(`{"a/b":1,"a${BS}/b":2}`)).toEqual(["/a~1b"]);
    expect(dups(`{"q${BS}"":1,"q${u("0022")}":2}`)).toEqual(["/q\""]);
    const smile = String.fromCodePoint(0x1f600);
    expect(dups(`{"${smile}":1,"${u("d83d")}${u("de00")}":2}`)).toEqual(["/??"]);
    expect(dups(`{"x":{"${u("006b")}":1,"k":2}}`)).toEqual(["/x/k"]);
    expect(dups(`{"a":1,"${u("0062")}":2}`)).toEqual([]);
  });
  test("it accepts exactly what JSON.parse accepts on this corpus, with the same value", () => {
    const good = ["{}", "[]", "0", "-0", "1.5e-3", "\"x\"", "true", "null", " \t\r\n{ \"a\" : [ 1 , 2 ] } ", `"${u("00e9")}${BS}n${BS}t"`,
      "[1E9,-2.5E+2,0.0]", "{\"__proto__\":1}", "[[[[{\"a\":{}}]]]]"];
    for (const text of good) {
      const r = strictJson(text);
      expect([text, r.ok]).toEqual([text, true]);
      if (r.ok) expect(r.value).toEqual(JSON.parse(text));
    }
    const bad = ["", "{\"a\":1,}", "[1,]", "{'a':1}", "01", "1.", ".5", "+1", "-", "NaN", "{\"a\":1} x", "{\"a\" 1}", "\"unterminated",
      `"${BS}x"`, `"${u("12")}"`, "\"a\tb\"", "{\"a\":1 /* c */}", String.fromCharCode(0xfeff) + "{}", "[1 2]", "{1:2}", "tru", "nul"];
    for (const text of bad) {
      expect([text, strictJson(text).ok]).toEqual([text, false]);
      expect([text, (() => { try { JSON.parse(text); return true; } catch { return false; } })()]).toEqual([text, false]);
    }
    expect(strictJson("[".repeat(300) + "]".repeat(300))).toEqual({ ok: false, error: "too_deep" });
  });
  test("a fixture with a duplicate key, an invalid file and a BOM-prefixed file fail hygiene.duplicate_keys", () => {
    const fixtures = {
      ...GOOD_FIXTURES,
      "acme.lookup/dup.json": `{"items":[{"name":"a","${u("006e")}ame":"b"}]}`,
      "acme.order.prepare/broken.json": "{\"draftId\": \"d\",}",
      "acme.order.confirm/bom.json": Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("{}")]),
    };
    withCatalog({ fixtures }, c => {
      const r = row(run(c), "hygiene.duplicate_keys");
      expect(r.pass).toBe(false);
      expect(r.note).toContain("acme.lookup/dup.json: duplicate key /items/0/name");
      expect(r.note).toContain("acme.order.prepare/broken.json: not strict JSON (expected_key)");
      expect(r.note).toContain("acme.order.confirm/bom.json: not strict JSON (unexpected_token)");
    });
  });
});

describe("item 5: secret patterns", () => {
  // Built at run time from parts, so no secret-shaped literal sits in this file.
  const A = (n: number) => "A1b2".repeat(Math.ceil(n / 4)).slice(0, n);
  const positives: [string, string][] = [
    ["sk_key", "s" + "k-" + A(24)],
    ["sk_key", "token is s" + "k-proj-" + A(30) + " here"],
    ["stripe_key", "s" + "k_live_" + A(24)],
    ["github_token", "gh" + "p_" + A(36)],
    ["github_token", "gh" + "s_" + A(36)],
    ["github_pat", "github" + "_pat_" + A(40)],
    ["slack_token", "xo" + "xb-" + A(20)],
    ["jwt", "ey" + "JhbGciOiJIUzI1NiJ9." + "ey" + "JzdWIiOiIxIn0." + A(20)],
    ["pem_private_key", "-----BEGIN " + "RSA PRIVATE KEY-----\nMIIB"],
    ["pem_private_key", "-----BEGIN " + "PRIVATE KEY-----"],
    ["aws_access_key_id", "AK" + "IA" + "ABCDEFGHIJKLMNOP"],
    ["aws_secret_assignment", "aws_secret_access_key" + " = " + A(40)],
    ["password_assignment", "https://x.example/?user=a&pass" + "word=hunter2"],
    ["password_assignment", "PASS" + "WORD = x"],
    ["bearer_value", "Authorization: Bear" + "er " + A(32)],
    ["av_bridge_token", "av" + "b_" + A(43)],
    ["google_api_key", "AI" + "za" + A(35)],
    ["npm_token", "np" + "m_" + A(36)],
    ["token_assignment", "access_" + "token=" + A(20)],
    ["jwt", "id=" + "ey" + "JhbGciOiJIUzI1NiJ9." + "ey" + "JzdWIiOiIxIn0." + A(20)],
    ["url_userinfo", "postgres://" + "app:" + "hunter2pass" + "@db.example:5432/x"],
    ["url_userinfo", "see https://" + "u:" + "p" + "@host.example/"],
    ["basic_auth", "Authorization: Bas" + "ic " + "dXNlcjpwYXNzd29yZA=="],
    ["basic_auth", "{\"authorization\": \"bas" + "ic " + "dXNlcjpwYXNz\"}"],
  ];
  const negatives = ["risk-assessment-framework-2026", "desk-0123456789abcdefghij", "s" + "k-short", "gh" + "p_short",
    "ey" + "JhbGciOiJIUzI1NiJ9", "Password: reset it from your settings", "The password reset link expired.",
    "passport=12345", "AK" + "IAshort", "a".repeat(64), "123e4567-e89b-12d3-a456-426614174000", "the bearer of good news",
    "task-0123456789abcdefghijklmn", "access token rotates daily", "avb_" + "short", "Total: 120 INR",
    "https://host.example:8443/path", "https://user@host.example/", "postgres://db.example:5432/app", "mailto:a@b.example",
    "Basic subscription: 5 USD a month", "the basic idea is simple", "x" + "ey" + "JhbGciOiJIUzI1NiJ9." + "ey" + "JzdWIiOiIxIn0." + A(20)];
  test("each pattern finds its shape, the note names the pattern and the place, and never the secret", () => {
    for (const [name, secret] of positives) {
      const found = secretFindings({ deep: [{ text: secret }] });
      expect([name, secret.length > 0, found.map(([at, p]) => `${show(at)} ${p}`)]).toEqual([name, true, [`/deep/0/text ${name}`]]);
    }
    const fixtures: Record<string, string> = { ...GOOD_FIXTURES };
    positives.forEach(([, secret], i) => { fixtures[`acme.lookup/s${i}.json`] = JSON.stringify({ note: secret }); });
    withCatalog({ fixtures }, c => {
      const r = run(c);
      expect(row(r, "hygiene.secrets").pass).toBe(false);
      const text = JSON.stringify(r);
      for (const [, secret] of positives) expect(text.includes(secret)).toBe(false);
      expect(row(r, "hygiene.secrets").note).toContain("acme.lookup/s0.json /note (sk_key)");
      expect(r.passed).toBe(false);
    });
  });
  test("false positives: ordinary response text is not a secret", () => {
    for (const text of negatives) expect([text, secretFindings({ text })]).toEqual([text, []]);
    expect(secretFindings({ password_hint: "x", password: "", token: "", tokenCount: "3", passwordSet: true, nextToken: "page-2",
      authorization: "required", "Proxy-Authorization": "not configured yet" })).toEqual([]);
    withCatalog({ fixtures: { ...GOOD_FIXTURES, "acme.lookup/prose.json": JSON.stringify({ lines: negatives }) } }, c => {
      expect(row(run(c), "hygiene.secrets").pass).toBe(true);
    });
  });
  test("a secret escaped in the raw text, held in a key, or named by its key is still found", () => {
    const hidden = `${u("0073")}k-` + A(24);
    const key = "gh" + "p_" + A(36);
    const fixtures = {
      ...GOOD_FIXTURES,
      "acme.lookup/escaped.json": `{"note":"${hidden}"}`,
      "acme.lookup/key.json": JSON.stringify({ [key]: 1 }),
      "acme.lookup/named.json": JSON.stringify({ auth: { client_secret: "plain-looking-value" } }),
      "acme.lookup/raw.json": "{\"broken\": \"s" + "k-" + A(24) + "\",}",
    };
    withCatalog({ fixtures }, c => {
      const r = row(run(c), "hygiene.secrets");
      expect(r.pass).toBe(false);
      expect(r.note).toContain("acme.lookup/escaped.json /note (sk_key)");
      expect(r.note).toContain("acme.lookup/key.json /<redacted> (github_token, in a key)");
      expect(r.note).toContain("acme.lookup/named.json /auth/client_secret (secret_key_name)");
      expect(r.note).toContain("acme.lookup/raw.json raw text (sk_key)");
      expect(r.note.includes(key)).toBe(false);
    });
  });
  test("a key that names a credential (review-b N3 names) or an Authorization header holding a scheme value is found", () => {
    const named = ["secret_key", "secretKey", "x-api-key", "X-API-Key", "token", "api_secret", "set-cookie", "Set-Cookie", "cookie",
      "password", "client_secret", "access_token"];
    for (const key of named) expect([key, secretFindings({ h: { [key]: "plain-looking-value" } })]).toEqual([key, [[["h", key], "secret_key_name"]]]);
    for (const key of ["Authorization", "authorization", "Proxy-Authorization"]) {
      for (const value of ["Bas" + "ic dXNlcjpwYXNz", "Dig" + "est username=x", "Tok" + "en " + A(12)]) {
        expect([key, value, secretFindings({ [key]: value }).map(([, p]) => p)]).toEqual([key, value, ["authorization_header"]]);
      }
    }
  });
  test("redaction removes an assignment's value too, not only its key (password=, aws_secret_access_key=)", () => {
    const values = [["pass" + "word=" + "hunter2-value", "hunter2-value"], ["PASS" + "WORD = " + "s3cr3t!x", "s3cr3t!x"],
      ["aws_secret_access_key" + " = " + A(40), A(40)], ["AWS_SECRET_ACCESS_KEY" + ":" + A(40), A(40)],
      ["db postgres://" + "app:" + "hunter2pass" + "@db.example/x", "hunter2pass"], ["Authorization: Bas" + "ic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA=="]];
    for (const [text, value] of values) {
      const r = redact(`before ${text} after`);
      expect([text, r.includes(value), r.includes("<redacted>"), r.startsWith("before "), r.endsWith(" after")]).toEqual([text, false, true, true, true]);
    }
  });
  test("ReDoS: every pattern is linear; 1 MB adversarial strings (eyJ-eyJ-... and one per shape) each scan in well under 2 s", () => {
    const MB = 1 << 20;
    const fill = (unit: string, prefix = "") => (prefix + unit.repeat(Math.ceil(MB / unit.length))).slice(0, MB);
    const cases: [string, string][] = [
      ["eyJ-", fill("ey" + "J-")], ["eyJ.", fill("ey" + "J.")], ["eyJ then a run", fill("a", "ey" + "J")], ["eyJ, a dot, a run", fill("a", "ey" + "Jaaaaaaaaa.")],
      ["a.a.", fill("a.")], ["x://u: then a run", fill("p", "x://u:")], ["x://x://", fill("x://")], ["u:u:", fill("u:", "x://")],
      ["authorization: ", fill("authorization: ")], ["authorization:basic ", fill("authorization:bas" + "ic ")],
      ["-----BEGIN A A", fill("A ", "-----BEGIN ")], ["password ", fill("pass" + "word ")], ["bearer ", fill("bear" + "er ")],
      ["api_key ", fill("api_" + "key ")], ["AKIA", fill("AK" + "IA")],
    ];
    for (const [name, text] of cases) {
      expect(text.length).toBe(MB);
      const t = performance.now();
      secretPattern(text);
      redact(text);
      secretFindings({ [text.slice(0, 64)]: text });
      const ms = performance.now() - t;
      expect([name, ms < 2000]).toEqual([name, true]);
    }
  }, 60000);
  test("a fixture file name cannot forge a summary line, and notes carry no control character", () => {
    const spoof = "x\n  PASS    hygiene.secrets: spoofed\n.json";
    withCatalog({ fixtures: { ...GOOD_FIXTURES, [`acme.lookup/${spoof}`]: JSON.stringify({ t: "s" + "k-" + A(24) }) } }, c => {
      const r = run(c);
      expect(row(r, "hygiene.secrets").pass).toBe(false);
      const control = new RegExp(`[${BS}x00-${BS}x1f${BS}x7f-${BS}x9f${String.fromCharCode(0x2028, 0x2029)}]`);
      for (const x of r.results) expect([x.check, control.test(x.note)]).toEqual([x.check, false]);
      const lines = summary(r).split("\n");
      expect(lines.filter(l => l.includes("spoofed")).every(l => l.startsWith("  FAIL    hygiene.secrets: "))).toBe(true);
      expect(lines.length).toBe(CHECKS.length + 2);
    });
    expect(redact(["a", "b", "c", "d"].join("\n").replace("b\nc", "b" + String.fromCharCode(0x2028) + "c").replace("c\nd", "c" + String.fromCharCode(7) + "d"))).toBe("a?b?c?d");
    expect(redact("x".repeat(5000)).length).toBe(4000);
    // A long name is shown cut to 64 characters, as every pointer segment is.
    const long = "n".repeat(100) + ".txt";
    withCatalog({ fixtures: { ...GOOD_FIXTURES, [`acme.lookup/${long}`]: "{}" } }, c => {
      const note = row(run(c), "hygiene.fixtures").note;
      expect([note.includes(long), note.includes(`acme.lookup/${"n".repeat(61)}...: not a .json file`)]).toEqual([false, true]);
    });
  });
  test("the pattern list covers the brief's shapes and the validator's own", () => {
    expect(SECRET_PATTERNS.map(([n]) => n)).toEqual(expect.arrayContaining(["sk_key", "github_token", "github_pat", "jwt",
      "pem_private_key", "password_assignment", "aws_access_key_id", "aws_secret_assignment", "slack_token"]));
  });
});

describe("item 5: error bodies and the fixture layout", () => {
  test("an error body is exactly {code, detail} with a code from the closed set", () => {
    const cases: [string, unknown, string][] = [
      ["an extra key", { code: "not_found", detail: "No such item.", trace: "x" }, "keys are code, detail, trace"],
      ["no detail", { code: "not_found" }, "keys are code, not exactly code, detail"],
      ["an open code", { code: "Something went wrong", detail: "x" }, "is not in the closed set for acme"],
      ["another app's code", { code: "zzz_not_found", detail: "x" }, "(it is zzzbot's)"],
      ["a code that is not a string", { code: 404, detail: "x" }, "code (not a string)"],
      ["an empty detail", { code: "not_found", detail: " " }, "detail is a non-empty string"],
      ["a long detail", { code: "not_found", detail: "x".repeat(1001) }, "detail is a non-empty string"],
      ["an array", [{ code: "not_found", detail: "x" }], "an error body is a {code, detail} object"],
    ];
    for (const [why, body, want] of cases) {
      withCatalog({ fixtures: { ...GOOD_FIXTURES, "acme.lookup/error-x.json": JSON.stringify(body) } }, c => {
        const r = row(run(c), "hygiene.error_bodies");
        expect([why, r.pass, r.note.includes(want)]).toEqual([why, false, true]);
      });
    }
    withCatalog({ fixtures: { ...GOOD_FIXTURES, "acme.lookup/ok-but.json": JSON.stringify({ error: "zzz_invalid" }) } }, c => {
      expect(row(run(c), "hygiene.error_bodies").note).toContain("a success fixture carries \"error\"");
    });
    for (const code of GENERIC_ERROR_CODES) {
      withCatalog({ fixtures: { ...GOOD_FIXTURES, "acme.order.confirm/error.json": JSON.stringify({ code, detail: "Fixed sentence." }) } }, c => {
        expect([code, row(run(c), "hygiene.error_bodies").pass]).toEqual([code, true]);
      });
    }
  });
  test("the closed set: each first-party app may use only its own bridge codes; any other app the generic list", () => {
    expect(allowedErrorCode("zzzbot", "zzz_not_found")).toBe(true);
    expect(allowedErrorCode("forkicks", "zzz_not_found")).toBe(false);
    expect(allowedErrorCode("forkicks", "pickup_only:latte-1")).toBe(true);
    expect(allowedErrorCode("acme", "pickup_only:latte-1")).toBe(false);
    expect(allowedErrorCode("gold-stars", "star_self")).toBe(true);
    expect(allowedErrorCode("gold-stars", "not_found")).toBe(false);
    expect(allowedErrorCode("slopfolio", "DRAFT_NOT_FOUND")).toBe(true);
    expect(allowedErrorCode("dizko", "not_found")).toBe(true);
    expect(allowedErrorCode("acme", "star_self")).toBe(false);
    for (const code of GENERIC_ERROR_CODES) expect(code).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
  });
  test("drift guard: every bridge code is still a literal in plugins/village-bridge/__init__.py", () => {
    const bridge = readFileSync(join(REPO, "plugins", "village-bridge", "__init__.py"), "utf8");
    for (const code of Object.keys(BRIDGE_ERROR_CODES)) expect([code, bridge.includes(`"${code}"`)]).toEqual([code, true]);
    expect(bridge.includes("pickup_only:[A-Za-z0-9_-]{1,128}")).toBe(true);
  });
  test("the layout is closed: unknown op directories, loose files, other extensions, symlinks, nesting and oversize fail", () => {
    const cases: [string, (dir: string) => void, string][] = [
      ["an unknown op", d => { mkdirSync(join(d, "acme.other")); writeFileSync(join(d, "acme.other", "ok.json"), "{}"); }, "acme.other/: not an operation of this manifest"],
      ["a loose file", d => writeFileSync(join(d, "ok.json"), "{}"), "ok.json: a fixture sits in an <operation>/ directory"],
      ["another extension", d => writeFileSync(join(d, "acme.lookup", "ok.txt"), "{}"), "acme.lookup/ok.txt: not a .json file"],
      ["a symlinked fixture", d => symlinkSync(join(d, "acme.lookup", "ok.json"), join(d, "acme.lookup", "link.json")), "acme.lookup/link.json: symlink"],
      ["a symlinked op dir", d => symlinkSync(join(d, "acme.lookup"), join(d, "acme.order.prepare")), "acme.order.prepare: symlink"],
      ["a nested directory", d => mkdirSync(join(d, "acme.lookup", "more")), "acme.lookup/more: not a regular file"],
      ["oversize", d => writeFileSync(join(d, "acme.lookup", "big.json"), JSON.stringify({ x: "y".repeat(5000) })), "is over acme.lookup's maxResponseBytes 4096"],
      ["a .DS_Store", d => writeFileSync(join(d, "acme.lookup", ".DS_Store"), ""), "acme.lookup/.DS_Store: not a .json file"],
    ];
    for (const [why, plant, want] of cases) {
      withCatalog({ fixtures: GOOD_FIXTURES }, c => {
        plant(c.fixtures);
        const r = run(c);
        invariants(r);
        expect([why, row(r, "hygiene.fixtures").pass, row(r, "hygiene.fixtures").note.includes(want)]).toEqual([why, false, true]);
        expect(r.passed).toBe(false);
      });
    }
  });
});

describe("the CLI", () => {
  test("arguments: one manifest path, each option once with a value, no unknown option", () => {
    expect(parseArgs(["--", "m/mini-apps/a/manifest.json", "--out", "o.json"])).toEqual({ manifest: "m/mini-apps/a/manifest.json", fixtures: undefined, out: "o.json", base: undefined });
    for (const bad of [[], ["a", "b"], ["a", "--out"], ["a", "--out", "--base"], ["a", "--out", "x", "--out", "y"], ["a", "--force"], ["a", "--base=HEAD"]]) {
      expect(() => parseArgs(bad)).toThrow(Refusal);
    }
  });
  test("exit codes from a real process: 0 passed with conformance.json written, 1 failed, 2 refused", () => {
    withCatalog({ fixtures: GOOD_FIXTURES }, c => {
      const out = join(c.root, "conformance.json");
      const ok = spawnSync("bun", [SCRIPT, c.path, "--fixtures", c.fixtures, "--out", out], { cwd: c.root, encoding: "utf8" });
      expect([ok.status, ok.stdout.trim().split("\n").at(-1)]).toEqual([0, "passed: true"]);
      const written = JSON.parse(readFileSync(out, "utf8"));
      invariants(written);
      expect(written.sha256).toBe(sha256(readFileSync(c.path)));
      expect(written.passed).toBe(true);
      const failed = spawnSync("bun", [SCRIPT, c.path], { cwd: c.root, encoding: "utf8" });
      expect(failed.status).toBe(1);
      const refusals: [string[], string][] = [
        [[], "one_manifest_path_expected"],
        [[join(c.root, "skills", "acme", "SKILL.md")], "manifest_path_must_be"],
        [[c.path, "--fixtures", join(c.root, "nope")], "fixtures_not_a_directory"],
        [[c.path, "--out", join(c.root, "nope", "c.json")], "out_directory_missing"],
        [[c.path, "--out", c.path], "out_would_overwrite_the_manifest"],
        [[c.path, "--unknown"], "unknown_option"],
        [[join(c.root, "mini-apps", "gone", "manifest.json")], "manifest_missing"],
      ];
      for (const [args, reason] of refusals) {
        const p = spawnSync("bun", [SCRIPT, ...args], { cwd: c.root, encoding: "utf8" });
        expect([args.join(" "), p.status, p.stderr.includes(reason)]).toEqual([args.join(" "), 2, true]);
      }
      expect(readFileSync(c.path, "utf8")).toBe(JSON.stringify(acme(), null, 2) + "\n");
    });
  });
  const quiet = { print: () => {}, warn: () => {} };
  test("--out: exit 2 leaves no conformance.json (a stale one is removed); exit 0 and 1 replace it; no --out writes no file", () => {
    withCatalog({ fixtures: GOOD_FIXTURES }, c => {
      const out = join(c.root, "conformance.json");
      const refusals: [string, string[]][] = [
        ["an unknown base ref", ["--base", "no-such-ref"]],
        ["a fixtures path that is not a directory", ["--fixtures", join(c.root, "nope")]],
      ];
      for (const [why, extra] of refusals) {
        writeFileSync(out, "{\"passed\": true}\n");
        expect([why, main([c.path, "--out", out, ...extra], { cwd: c.root, ...quiet }), existsSync(out)]).toEqual([why, 2, false]);
      }
      // A pin mismatch (the tool refuses before reading anything) removes it too.
      writeFileSync(out, "{\"passed\": true}\n");
      const tool = realpathSync(mkdtempSync(join(tmpdir(), "conformance-tool-")));
      try {
        mkdirSync(join(tool, "mini-apps"));
        writeFileSync(join(tool, "mini-apps", "manifests.pins.json"), "{}");
        expect([main([c.path, "--fixtures", c.fixtures, "--out", out], { cwd: c.root, toolRoot: tool, ...quiet }), existsSync(out)]).toEqual([2, false]);
      } finally { rmSync(tool, { recursive: true, force: true }); }
      // Exit 1 and exit 0 replace a stale file with this run's report.
      writeFileSync(out, "{\"passed\": true}\n");
      expect(main([c.path, "--out", out], { cwd: c.root, ...quiet })).toBe(1);
      expect(JSON.parse(readFileSync(out, "utf8")).passed).toBe(false);
      expect(main([c.path, "--fixtures", c.fixtures, "--out", out], { cwd: c.root, ...quiet })).toBe(0);
      expect(JSON.parse(readFileSync(out, "utf8")).passed).toBe(true);
      // No temp file is left beside it.
      expect(readdirSync(c.root).filter(n => n.includes(".tmp-"))).toEqual([]);
      // Without --out nothing is written: not next to the manifest, not anywhere in the catalog.
      rmSync(out);
      const before = readdirSync(c.root, { recursive: true }).map(String).sort();
      expect(main([c.path, "--fixtures", c.fixtures], { cwd: c.root, ...quiet })).toBe(0);
      expect(readdirSync(c.root, { recursive: true }).map(String).sort()).toEqual(before);
      expect(readdirSync(join(c.root, "mini-apps", "acme"))).toEqual(["manifest.json"]);
    });
  });
  test("an internal error (not a Refusal) exits 2 with only the error's name, and leaves no conformance.json", () => {
    withCatalog({ fixtures: GOOD_FIXTURES }, c => {
      const out = join(c.root, "conformance.json");
      const warned: string[] = [];
      const code = main([c.path, "--fixtures", c.fixtures, "--out", out], { cwd: c.root, print: () => { throw new TypeError("boom s" + "k-" + "A1b2".repeat(6)); }, warn: s => warned.push(s) });
      expect([code, warned, existsSync(out)]).toEqual([2, ["conformance: refused: internal error TypeError"], false]);
    });
  });
  test("the temp file is opened exclusively (wx): a file or symlink planted at its name is never written through", () => {
    withCatalog({ fixtures: GOOD_FIXTURES }, c => {
      const out = join(c.root, "conformance.json");
      const target = join(c.root, "victim.txt");
      writeFileSync(target, "untouched\n");
      symlinkSync(target, `${out}.tmp-${process.pid}`);
      const warned: string[] = [];
      expect(main([c.path, "--fixtures", c.fixtures, "--out", out], { cwd: c.root, print: () => {}, warn: s => warned.push(s) })).toBe(2);
      expect([warned.join(""), readFileSync(target, "utf8"), existsSync(out)]).toEqual(["conformance: refused: internal error Error", "untouched\n", false]);
      expect(lstatSync(`${out}.tmp-${process.pid}`).isSymbolicLink()).toBe(true);
    });
  });
  test("--out may not be the manifest (same dev+ino: a hard link, a symlink) or under mini-apps/ (any case on a case-insensitive fs)", () => {
    // The tool's own mini-apps/ is a throwaway copy: a mutant that drops a guard can never touch the repo.
    const tool = realpathSync(mkdtempSync(join(tmpdir(), "conformance-tool-")));
    for (const rel of ["scripts/mini-apps-manifests.cjs", "mini-apps/manifest.v2.schema.json", "mini-apps/manifests.pins.json"]) {
      mkdirSync(dirname(join(tool, rel)), { recursive: true });
      copyFileSync(join(REPO, rel), join(tool, rel));
    }
    mkdirSync(join(tool, "mini-apps", "gold-stars"));
    try { withCatalog({ fixtures: GOOD_FIXTURES }, c => {
      const bytes = readFileSync(c.path);
      const pins = readFileSync(join(tool, "mini-apps", "manifests.pins.json"));
      linkSync(c.path, join(c.root, "hard-link.json"));
      symlinkSync(c.path, join(c.root, "sym-link.json"));
      mkdirSync(join(c.root, "elsewhere"));
      symlinkSync(join(c.root, "mini-apps"), join(c.root, "elsewhere", "apps"));
      const unsafe: string[] = [
        c.path, "mini-apps/acme/manifest.json", "./mini-apps/../mini-apps/acme/manifest.json", "hard-link.json", "sym-link.json",
        "mini-apps/acme/other.json", "mini-apps/conformance.json", "mini-apps/acme/fixtures.json", "elsewhere/apps/acme/x.json",
        join(tool, "mini-apps", "manifests.pins.json"), join(tool, "mini-apps", "gold-stars", "conformance.json"),
      ];
      for (const arg of unsafe) {
        const warned: string[] = [];
        expect([arg, main([c.path, "--fixtures", c.fixtures, "--out", arg], { cwd: c.root, toolRoot: tool, print: () => {}, warn: s => warned.push(s) }),
          warned.join("").includes("refused: out_would_overwrite_the_manifest_or_mini-apps")]).toEqual([arg, 2, true]);
      }
      // Case variants: on a case-insensitive filesystem (macOS) they name the manifest or mini-apps/ and
      // refuse as unsafe; on a case-sensitive one the directory does not exist. Either way: exit 2.
      const folds = existsSync(join(c.root, "MINI-APPS"));
      for (const arg of ["mini-apps/acme/MANIFEST.json", "MINI-APPS/acme/manifest.json", "Mini-Apps/ACME/x.json"]) {
        const warned: string[] = [];
        expect([arg, main([c.path, "--fixtures", c.fixtures, "--out", arg], { cwd: c.root, toolRoot: tool, print: () => {}, warn: s => warned.push(s) })]).toEqual([arg, 2]);
        const reason = folds || arg.startsWith("mini-apps/") ? "out_would_overwrite_the_manifest_or_mini-apps" : "out_directory_missing";
        expect([arg, warned.join("").includes(`refused: ${reason}`)]).toEqual([arg, true]);
      }
      // Nothing it guards was touched, and none of the refused paths was removed or created.
      expect(readFileSync(c.path).equals(bytes)).toBe(true);
      expect(readFileSync(join(tool, "mini-apps", "manifests.pins.json")).equals(pins)).toBe(true);
      expect(readdirSync(join(c.root, "mini-apps", "acme"))).toEqual(["manifest.json"]);
      expect([existsSync(join(c.root, "hard-link.json")), lstatSync(join(c.root, "sym-link.json")).isSymbolicLink()]).toEqual([true, true]);
      expect(readdirSync(join(tool, "mini-apps", "gold-stars"))).toEqual([]);
      // A directory refuses; a symlinked parent directory outside mini-apps/ (e.g. macOS /tmp) is followed.
      expect(main([c.path, "--out", "elsewhere"], { cwd: c.root, ...quiet })).toBe(2);
      mkdirSync(join(c.root, "real-out"));
      symlinkSync(join(c.root, "real-out"), join(c.root, "out-link"));
      expect(main([c.path, "--fixtures", c.fixtures, "--out", "out-link/c.json"], { cwd: c.root, toolRoot: tool, ...quiet })).toBe(0);
      expect(JSON.parse(readFileSync(join(c.root, "real-out", "c.json"), "utf8")).passed).toBe(true);
    }); } finally { rmSync(tool, { recursive: true, force: true }); }
  });
  test("bun run conformance -- <manifest> from the repo root (the package.json script)", () => {
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
    expect(pkg.scripts).toEqual({ conformance: "bun scripts/mini-apps-conformance.ts" });
    const p = spawnSync("bun", ["run", "conformance", "--", "mini-apps/dizko/manifest.json"], { cwd: REPO, encoding: "utf8" });
    expect([p.status, p.stdout.includes("conformance mini-apps/dizko/manifest.json sha256 ")]).toEqual([1, true]);
  });
});

describe("the five real manifests", () => {
  const index = JSON.parse(readFileSync(join(REPO, "mini-apps", "catalog.json"), "utf8"));
  test("each runs without crashing: item 1 passes, item 5 is not_run (no fixtures in the closed mini-apps/ tree), so each fails honestly", () => {
    expect(index.apps).toEqual(["gold-stars", "dizko", "zzzbot", "slopfolio", "forkicks"]);
    for (const id of index.apps) {
      const r = runConformance({ manifest: `mini-apps/${id}/manifest.json` }, { cwd: REPO });
      invariants(r);
      expect([id, r.sha256]).toEqual([id, sha256(readFileSync(join(REPO, "mini-apps", id, "manifest.json")))]);
      const got = Object.fromEntries(r.results.map(x => [x.check, x.pass]));
      expect([id, got]).toEqual([id, {
        "manifest.validator_pin": true, "manifest.schema": true, "skills.sha256": true, "version.bump": null,
        "service.reachability": null, "service.budgets": null,
        "approval.prepare_pair": true, "approval.summary_render": null, "approval.fake_cp": null,
        "hygiene.fixtures": null, "hygiene.secrets": null, "hygiene.duplicate_keys": null, "hygiene.error_bodies": null,
      }]);
      expect([id, r.passed]).toEqual([id, false]);
      expect(main([`mini-apps/${id}/manifest.json`], { cwd: REPO, print: () => {}, warn: () => {} })).toBe(1);
    }
  });
});
