import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { REVIEWED_MINI_APPS } from "../install_miniapps";
import { reconcileZzzManagedJob, ZZZ_JOB_NAME, ZZZ_JOB_SCRIPT, ZZZ_JOB_TOOLSETS } from "../zzz_managed_job";

const fake = join(import.meta.dir, "fake_hermes.ts");
const fakeJobPython = join(import.meta.dir, "fake_hermes_job_python.ts");
const saved = { HERMES_HOME: process.env.HERMES_HOME, HERMES_BIN: process.env.HERMES_BIN,
  PYTHONPATH: process.env.PYTHONPATH, PYTHONHOME: process.env.PYTHONHOME };
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** A box with a fake bound Hermes; `stage` runs the real CLI helper as the cp's runHelper does (stdin). */
function fakeBox() {
  const home = mkdtempSync(join(tmpdir(), "av-zzz-job-"));
  roots.push(home);
  const bin = join(home, "bin", "hermes");
  const python = join(home, "venv", "bin", "python");
  const entrypoint = join(home, "hermes_cli", "main.py");
  mkdirSync(join(home, "bin"));
  mkdirSync(join(home, "venv", "bin"), { recursive: true });
  mkdirSync(join(home, "hermes_cli"));
  writeFileSync(entrypoint, "# fake bound Hermes entrypoint\n");
  writeFileSync(bin, `#!/usr/bin/env bash\nunset PYTHONPATH\nunset PYTHONHOME\nexec "${python}" "${entrypoint}" "$@"\n`);
  chmodSync(bin, 0o755);
  writeFileSync(join(home, "bin", "python"), "#!/usr/bin/env bash\nexit 99\n");
  chmodSync(join(home, "bin", "python"), 0o755);
  writeFileSync(python, `#!/usr/bin/env bash\nif [ "$1" = "-c" ]; then\n  shift 2\n  exec "${process.execPath}" "${fakeJobPython}" "$@"\nfi\nshift\nexec "${process.execPath}" "${fake}" "$@"\n`);
  chmodSync(python, 0o755);
  process.env.HERMES_HOME = home;
  process.env.HERMES_BIN = bin;
  process.env.PYTHONPATH = join(home, "untrusted-imports");
  process.env.PYTHONHOME = join(home, "untrusted-home");
  const stage = (value: unknown, args: string[] = [], env: Record<string, string> = {}) => spawnSync(process.execPath,
    ["--no-env-file", "--no-install", "install/install_miniapps.ts", ...args],
    { cwd: join(import.meta.dir, "../.."), input: typeof value === "string" ? value : JSON.stringify(value),
      env: { ...process.env, ...env, HERMES_HOME: home }, encoding: "utf8" });
  const jobs = () => existsSync(join(home, "cron", "jobs.json")) ? JSON.parse(readFileSync(join(home, "cron", "jobs.json"), "utf8")).jobs : [];
  return { home, stage, jobs };
}
const zzzbot = REVIEWED_MINI_APPS.find(app => app.id === "zzzbot")!;
const bridge = REVIEWED_MINI_APPS.find(app => app.id === "zzz-bridge")!;
const alone = { version: 1, apps: [zzzbot] };
const projection = { version: 1, apps: [zzzbot, bridge] };
/** Nothing of managed participation on the box: no job, shim, prompt, script or cursor state. */
function expectOff(home: string, jobs: () => unknown[]) {
  expect(jobs()).toHaveLength(0);
  expect(existsSync(join(home, "scripts", ZZZ_JOB_SCRIPT))).toBe(false);
  expect(existsSync(join(home, "skills", "zzzbot", "prompts", "participate.md"))).toBe(false);
  expect(existsSync(join(home, "skills", "zzzbot", "scripts", ZZZ_JOB_SCRIPT))).toBe(false);
  expect(existsSync(join(home, "zzzbot"))).toBe(false);
}

test("installed ZZZ projection owns one Hermes agent job; revocation removes it", () => {
  const { home, stage, jobs } = fakeBox();
  expect(stage(alone).status).toBe(0);
  expect(existsSync(join(home, "cron", "jobs.json"))).toBe(false);
  expect(existsSync(join(home, "scripts", ZZZ_JOB_SCRIPT))).toBe(false);
  expect(existsSync(join(home, "skills", "zzzbot", "prompts", "participate.md"))).toBe(false);
  expect(existsSync(join(home, "zzzbot"))).toBe(false);
  expect(stage(projection).status).toBe(0);
  reconcileZzzManagedJob(home, true);
  expect(jobs()).toHaveLength(1);
  expect(jobs()[0]).toMatchObject({ name: ZZZ_JOB_NAME, script: ZZZ_JOB_SCRIPT, enabled: true,
    enabled_toolsets: [...ZZZ_JOB_TOOLSETS] });
  expect(jobs()[0].no_agent).not.toBe(true);
  const id = jobs()[0].id;
  reconcileZzzManagedJob(home, true);
  expect(jobs()).toHaveLength(1);
  expect(jobs()[0].id).toBe(id);
  // Installer repairs a stale, overbroad record before another run.
  const widened = jobs();
  widened[0].enabled_toolsets = ["all"];
  writeFileSync(join(home, "cron", "jobs.json"), JSON.stringify({ jobs: widened }));
  reconcileZzzManagedJob(home, true);
  expect(jobs()[0].enabled_toolsets).toEqual([...ZZZ_JOB_TOOLSETS]);
  expect(jobs()[0].id).not.toBe(id);
  mkdirSync(join(home, "zzzbot"));
  writeFileSync(join(home, "zzzbot", "managed-pairs.json"), "{}");
  writeFileSync(join(home, "zzzbot", "managed-pairs.lock"), "");
  expect(stage(alone).status).toBe(0);
  expect(jobs()).toHaveLength(0);
  expect(existsSync(join(home, "scripts", ZZZ_JOB_SCRIPT))).toBe(false);
  expect(existsSync(join(home, "skills", "zzzbot", "prompts", "participate.md"))).toBe(false);
  expect(existsSync(join(home, "zzzbot"))).toBe(false);
  expect(existsSync(join(home, "skills", "zzzbot", "SKILL.md"))).toBe(true);
});

test("S1 (b): zzzbot without zzz-bridge, and zzz-bridge without zzzbot, schedule nothing; no flag or env turns it on", () => {
  const { home, stage, jobs } = fakeBox();
  // (d) The app's and pair flags, and any would-be overlay switch, are not read by the installer.
  const flags = { ZZZ_BRIDGE: "1", AV_PAIR_ENABLED: "1", ZZZ_MANAGED_PARTICIPATION: "true", ZZZ_BRIDGE_ENABLED: "1" };
  expect(stage(alone, [], flags).status).toBe(0);
  expectOff(home, jobs);
  expect(stage({ version: 1, apps: [bridge] }, [], flags).status).toBe(0);
  expectOff(home, jobs);
  // zzzbot's skill is unstaged; the installer never removes a directory (a resident's files may sit in it).
  expect(readdirSync(join(home, "skills", "zzzbot"))).toEqual([]);
  // (a) The pair turns it on.
  expect(stage(projection).status).toBe(0);
  expect(jobs()).toHaveLength(1);
  expect(existsSync(join(home, "scripts", ZZZ_JOB_SCRIPT))).toBe(true);
});

test("S1 (c): an unreadable or malformed projection is OFF: the CLI tears the job, shim, files and state down", () => {
  const { home, stage, jobs } = fakeBox();
  const underscore = { version: 1, apps: [zzzbot, { ...bridge, id: "zzz_bridge" }] };
  const malformed: unknown[] = [
    "not json", "", "{\"version\":1,\"apps\":[", { version: 2, apps: [zzzbot, bridge] }, { version: 1, apps: [zzzbot, bridge], extra: 1 },
    underscore, { version: 1, apps: [zzzbot, bridge, { ...bridge, id: "zzz_bridge" }] },
    { version: 1, apps: [zzzbot, { ...bridge, operations: ["zzz.pairs"] }] }, { version: 1, apps: [zzzbot, { ...bridge, skills: ["zzz-bridge"] }] },
    { version: 1, apps: [zzzbot, bridge, bridge] }, "x".repeat(16385),
  ];
  for (const value of malformed) {
    expect(stage(projection).status).toBe(0);
    expect(jobs()).toHaveLength(1);
    mkdirSync(join(home, "zzzbot"), { recursive: true });
    writeFileSync(join(home, "zzzbot", "managed-pairs.json"), "{}");
    // --verify never mutates, even on a malformed input.
    expect(stage(value, ["--verify"]).status).toBe(1);
    expect(jobs()).toHaveLength(1);
    const result = stage(value);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("mini_apps_reconcile_failed");
    expectOff(home, jobs);
  }
});

/** Every file under `root` with its bytes and mode (directories by mode), for "nothing else changed" proofs. */
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
const FAILED = `${JSON.stringify({ error: "mini_apps_reconcile_failed" })}\n`;
/** Exactly the paths a fail-closed teardown may remove: the job's shim, the two managed files, the cursor state. */
const ZZZ_OWNED = [`scripts/${ZZZ_JOB_SCRIPT}`, `skills/zzzbot/scripts/${ZZZ_JOB_SCRIPT}`, "skills/zzzbot/prompts/participate.md",
  "zzzbot/managed-pairs.json", "zzzbot/managed-pairs.lock", "zzzbot/.managed-123"];
/** Managed cursor state as the poll leaves it, beside a resident's own file in the same folder. */
function seedState(home: string) {
  mkdirSync(join(home, "zzzbot"), { recursive: true });
  writeFileSync(join(home, "zzzbot", "managed-pairs.json"), "{}");
  writeFileSync(join(home, "zzzbot", "managed-pairs.lock"), "");
  writeFileSync(join(home, "zzzbot", ".managed-123"), "{}");
}

test("S1 teardown scope (nonav L17033): a failed stage removes ONLY the zzz job, shim, managed files and state", () => {
  const { home, stage, jobs } = fakeBox();
  const full = { version: 1, apps: REVIEWED_MINI_APPS };
  const unknown = { version: 1, apps: [...REVIEWED_MINI_APPS, { id: "unknown-app", version: "1.0.0", operations: ["mini-app.read"], skills: ["unknown-app"] }] };
  for (const failure of [{ input: "not json" as unknown, args: [] as string[] }, { input: unknown, args: [] }, { input: full, args: ["--force"] }]) {
    expect(stage(full).status).toBe(0);
    expect(jobs()).toHaveLength(1);
    seedState(home);
    // Everything else a box holds: other jobs (the near-miss name included), resident files beside every
    // managed path, the other mini-apps' skills and Gold Stars (baseline skill + its projection authority).
    const others = [{ id: "aaaaaaaaaaaa", name: "Morning digest", script: "digest.sh", enabled: true },
      { id: "bbbbbbbbbbbb", name: `${ZZZ_JOB_NAME} (resident copy)`, script: ZZZ_JOB_SCRIPT, enabled: true }];
    writeFileSync(join(home, "cron", "jobs.json"), JSON.stringify({ jobs: [...others, ...jobs()] }));
    for (const [path, bytes] of [["zzzbot/resident.txt", "mine"], ["scripts/resident.sh", "#!/bin/sh\n"],
      ["skills/zzzbot/scripts/resident.sh", "#!/bin/sh\n"], ["skills/zzzbot/prompts/resident.md", "mine"],
      ["skills/zzzbot/notes.md", "mine"], ["memories/MEMORY.md", "resident memory"], ["village-bridge.json", "{}"]]) {
      mkdirSync(join(home, path, ".."), { recursive: true });
      writeFileSync(join(home, path), bytes);
    }
    const before = snapshot(home);
    for (const path of ZZZ_OWNED) expect(before).toHaveProperty([path]);
    for (const app of REVIEWED_MINI_APPS) if (app.skills.length) expect(before).toHaveProperty([`skills/${app.id}/SKILL.md`]);
    const result = stage(failure.input, failure.args);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(FAILED);
    expect(jobs()).toEqual(others);
    const after = snapshot(home);
    const expected = { ...before };
    // jobs.json is compared above; the fake Hermes's own call logs are the harness's, not the box's.
    const harness = ["cron/jobs.json", "hermes-calls.jsonl", "hermes-env.jsonl"];
    for (const path of [...ZZZ_OWNED, ...harness]) delete expected[path];
    for (const path of harness) delete after[path];
    expect(after).toEqual(expected);
    // Gold Stars and every other app keep their authority: the projection file is untouched.
    expect(after["mini-apps.json"]).toBe(before["mini-apps.json"]);
    expect(JSON.parse(readFileSync(join(home, "mini-apps.json"), "utf8"))).toEqual(full);
    rmSync(join(home, "cron", "jobs.json"));
  }
});

test("S1 teardown is idempotent (nonav L17033): a second failed run on a clean box exits cleanly and changes nothing", () => {
  const { home, stage, jobs } = fakeBox();
  // A box that never had participation: a failed stage writes nothing and needs no Hermes.
  const fresh = snapshot(home);
  let result = stage("not json");
  expect([result.status, result.stdout, result.stderr]).toEqual([1, "", FAILED]);
  expect(snapshot(home)).toEqual(fresh);
  // Participation on, then torn down by a failed stage, then failed again (and again with Hermes gone).
  expect(stage(projection).status).toBe(0);
  seedState(home);
  result = stage("not json");
  expect([result.status, result.stdout, result.stderr]).toEqual([1, "", FAILED]);
  expectOff(home, jobs);
  const clean = snapshot(home);
  for (const env of [{}, { HERMES_BIN: join(home, "missing", "hermes") }]) {
    for (const input of ["not json", JSON.stringify({ version: 1, apps: [zzzbot, { ...bridge, id: "zzz_bridge" }] })]) {
      result = stage(input, [], env);
      expect([result.status, result.stdout, result.stderr]).toEqual([1, "", FAILED]);
      expect(snapshot(home)).toEqual(clean);
    }
  }
  expectOff(home, jobs);
});

test("S1 review follow-up: after a failed stage the pair may stay in mini-apps.json, but only a fresh good stage reinstalls", () => {
  const { home, stage, jobs } = fakeBox();
  expect(stage(projection).status).toBe(0);
  seedState(home);
  expect(stage("not json").status).toBe(1);
  expectOff(home, jobs);
  // Teardown never touches the projection file (Gold Stars and the other apps keep their authority).
  expect(JSON.parse(readFileSync(join(home, "mini-apps.json"), "utf8"))).toEqual(projection);
  // Nothing short of a good stage carrying the pair puts the job back: --verify of the pair, failed stages,
  // zzzbot alone, the bridge alone.
  for (const [input, args, status] of [[projection, ["--verify"], 1], ["not json", [], 1], [alone, [], 0],
    [{ version: 1, apps: [bridge] }, [], 0], [{ version: 1, apps: [zzzbot, { ...bridge, id: "zzz_bridge" }] }, [], 1]] as [unknown, string[], number][]) {
    expect(stage(input, args).status).toBe(status);
    expectOff(home, jobs);
  }
  expect(stage(projection).status).toBe(0);
  expect(jobs()).toHaveLength(1);
});

const PLUGIN = join(import.meta.dir, "..", "..", "plugins", "village-bridge");
/** The plugin's participation_on(home), through its package (python3 -I, the probe outside the plugin folder). */
function pluginParticipation(home: string): string {
  const which = Bun.which("python3");
  expect(which).not.toBeNull();
  const python = spawnSync(which!, ["-I", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim();
  const probe = mkdtempSync(join(tmpdir(), "av-zzz-probe-"));
  roots.push(probe);
  writeFileSync(join(probe, "probe.py"), [
    "import importlib.util, sys",
    "from pathlib import Path",
    'spec = importlib.util.spec_from_file_location("village_bridge", Path(sys.argv[1]) / "__init__.py")',
    "package = importlib.util.module_from_spec(spec)",
    "sys.modules[spec.name] = package",
    "spec.loader.exec_module(package)",
    'print(sys.modules["village_bridge._zzz_managed"].participation_on(Path(sys.argv[2])))',
    "",
  ].join("\n"));
  const env: Record<string, string> = { HERMES_HOME: home, PATH: "/usr/bin:/bin" };
  const run = spawnSync(python, ["-I", join(probe, "probe.py"), PLUGIN, home], { cwd: probe, env, encoding: "utf8" });
  expect(run.status).toBe(0);
  return run.stdout.trim();
}

test("S1 (nonav L17033): a malformed mini-apps.json with the job present is OFF, and the next install run removes the job", () => {
  const { home, stage, jobs } = fakeBox();
  const next: { label: string; input: unknown; status: number }[] = [
    { label: "zzzbot alone", input: alone, status: 0 },
    { label: "nothing projected", input: { version: 1, apps: [] }, status: 0 },
    { label: "a failed stage", input: "not json", status: 1 },
  ];
  for (const { label, input, status } of next) {
    expect(stage(projection).status).toBe(0);
    expect(jobs()).toHaveLength(1);
    expect(pluginParticipation(home)).toBe("True");
    for (const bad of ["{\"version\":1,\"apps\":[", JSON.stringify({ version: 1, apps: [zzzbot, bridge], extra: 1 }), ""]) {
      writeFileSync(join(home, "mini-apps.json"), bad);
      expect(jobs()).toHaveLength(1);
      expect(`${label}: ${pluginParticipation(home)}`).toBe(`${label}: False`);
    }
    seedState(home);
    expect(`${label}: ${stage(input).status}`).toBe(`${label}: ${status}`);
    expectOff(home, jobs);
  }
  // The cp re-staging the pair repairs the file and turns participation back on (that is the grant, not a leak).
  writeFileSync(join(home, "mini-apps.json"), "{");
  expect(stage(projection).status).toBe(0);
  expect(jobs()).toHaveLength(1);
  expect(pluginParticipation(home)).toBe("True");
});

/** The plugin's installed(home, app, op) for each pair, through its package (python3 -I, outside the plugin folder). */
function pluginInstalled(home: string, pairs: [string, string][]): boolean[] {
  const which = Bun.which("python3");
  expect(which).not.toBeNull();
  const python = spawnSync(which!, ["-I", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim();
  const probe = mkdtempSync(join(tmpdir(), "av-zzz-probe-"));
  roots.push(probe);
  writeFileSync(join(probe, "probe.py"), [
    "import importlib.util, json, sys",
    "from pathlib import Path",
    'spec = importlib.util.spec_from_file_location("village_bridge", Path(sys.argv[1]) / "__init__.py")',
    "package = importlib.util.module_from_spec(spec)",
    "sys.modules[spec.name] = package",
    "spec.loader.exec_module(package)",
    'mini = sys.modules["village_bridge._mini_apps"]',
    "print(json.dumps([mini.installed(Path(sys.argv[2]), app, op) for app, op in json.loads(sys.argv[3])]))",
    "",
  ].join("\n"));
  const run = spawnSync(python, ["-I", join(probe, "probe.py"), PLUGIN, home, JSON.stringify(pairs)],
    { cwd: probe, env: { HERMES_HOME: home, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
  expect(run.status).toBe(0);
  return JSON.parse(run.stdout);
}
const gold = REVIEWED_MINI_APPS.find(app => app.id === "gold-stars")!;
const forkicks = REVIEWED_MINI_APPS.find(app => app.id === "forkicks")!;
/**
 * No Hermes anywhere: HERMES_BIN missing, and HOME (a separate empty folder, so bun's own cache stays out of the box)
 * and PATH isolated so no fixed launcher (~/.local/bin/hermes on a dev machine) resolves.
 */
function HERMES_GONE(home: string) {
  const elsewhere = mkdtempSync(join(tmpdir(), "av-zzz-nohome-"));
  roots.push(elsewhere);
  return { HERMES_BIN: join(home, "missing", "hermes"), HOME: elsewhere, PATH: "/usr/bin:/bin" };
}

test("review-b S3: a failed job install keeps Gold Stars and For Kicks authorised and tears down only the zzz-managed items", () => {
  const { home, stage, jobs } = fakeBox();
  const before = { version: 1, apps: [gold, forkicks, zzzbot] };
  const granted = { version: 1, apps: [gold, forkicks, zzzbot, bridge] };
  const others: [string, string][] = [["gold-stars", "rolodex.search"], ["forkicks", "forkicks.menu"]];
  expect(stage(before).status).toBe(0);
  expect(pluginInstalled(home, others)).toEqual([true, true]);
  // The cp grants zzz-bridge on a box whose Hermes is missing: the stage fails on every retry, and every retry leaves
  // the other apps' authority published (the projection is written before the job install, never apps:[]).
  for (let retry = 0; retry < 3; retry++) {
    seedState(home);
    const result = stage(granted, [], HERMES_GONE(home));
    expect([result.status, result.stdout, result.stderr]).toEqual([1, "", FAILED]);
    expect(JSON.parse(readFileSync(join(home, "mini-apps.json"), "utf8"))).toEqual(granted);
    expect(pluginInstalled(home, others)).toEqual([true, true]);
    expect(existsSync(join(home, "skills", "forkicks", "SKILL.md"))).toBe(true);
    expect(existsSync(join(home, "skills", "zzzbot", "SKILL.md"))).toBe(true);
    // The zzz-managed job, shim, prompt, script and cursor state are torn down (expectOff), so nothing managed runs.
    expectOff(home, jobs);
    expect(pluginParticipation(home)).toBe("True");
  }
  // Hermes back: the next good stage installs the job.
  expect(stage(granted).status).toBe(0);
  expect(jobs()).toHaveLength(1);
  expect(pluginInstalled(home, others)).toEqual([true, true]);
});

test("review-b N2: with the gate off, a jobs.json or scripts/ shape the installer never wrote never fails the stage", () => {
  type Shape = { label: string; seed: (home: string, elsewhere: string) => void };
  const shapes: Shape[] = [
    { label: "bare-list jobs.json", seed: home => { mkdirSync(join(home, "cron")); writeFileSync(join(home, "cron", "jobs.json"), "[]"); } },
    { label: "bare-list jobs.json with a resident job", seed: home => { mkdirSync(join(home, "cron"));
      writeFileSync(join(home, "cron", "jobs.json"), JSON.stringify([{ id: "aaaaaaaaaaaa", name: "Morning digest", script: "digest.sh", enabled: true }])); } },
    { label: "unparseable jobs.json", seed: home => { mkdirSync(join(home, "cron")); writeFileSync(join(home, "cron", "jobs.json"), "{not json"); } },
    { label: "jobs.json of another shape", seed: home => { mkdirSync(join(home, "cron")); writeFileSync(join(home, "cron", "jobs.json"), "\"jobs\""); } },
    { label: "symlinked scripts/", seed: (home, elsewhere) => {
      writeFileSync(join(elsewhere, ZZZ_JOB_SCRIPT), "#!/bin/sh\necho resident\n");
      writeFileSync(join(elsewhere, "resident.sh"), "#!/bin/sh\n");
      symlinkSync(elsewhere, join(home, "scripts")); } },
  ];
  const projections = [{ version: 1, apps: [] }, { version: 1, apps: [gold] }, alone, { version: 1, apps: [bridge] }];
  for (const { label, seed } of shapes) {
    for (const value of projections) {
      const { home, stage } = fakeBox();
      const elsewhere = mkdtempSync(join(tmpdir(), "av-zzz-elsewhere-"));
      roots.push(elsewhere);
      seed(home, elsewhere);
      const name = `${label} / ${value.apps.map(app => app.id).join("+") || "nothing"}`;
      const cron = existsSync(join(home, "cron", "jobs.json")) ? readFileSync(join(home, "cron", "jobs.json"), "utf8") : null;
      const outside = snapshot(elsewhere);
      const empty = value.apps.length === 0 ? snapshot(home) : null;
      // No Hermes is needed (nor called): there is no managed job to remove.
      for (const args of [[], ["--verify"]]) {
        const result = stage(value, args, HERMES_GONE(home));
        expect(`${name} ${args}: ${result.status} ${result.stderr}`).toBe(`${name} ${args}: 0 `);
      }
      const cronAfter = existsSync(join(home, "cron", "jobs.json")) ? readFileSync(join(home, "cron", "jobs.json"), "utf8") : null;
      expect(`${name}: ${cronAfter}`).toBe(`${name}: ${cron}`);
      expect(snapshot(elsewhere)).toEqual(outside);
      if (empty) expect(snapshot(home)).toEqual(empty);
      expect(existsSync(join(home, "hermes-calls.jsonl"))).toBe(false);
      expect(existsSync(join(home, "zzzbot"))).toBe(false);
      if (value.apps.length) expect(JSON.parse(readFileSync(join(home, "mini-apps.json"), "utf8"))).toEqual(value);
    }
  }
});

test("review-b N2: gate off still removes a managed job from a bare-list store, and refuses a store Hermes cannot load that names it", () => {
  const { home, stage, jobs } = fakeBox();
  expect(stage(projection).status).toBe(0);
  const managedJob = jobs()[0];
  const resident = { id: "aaaaaaaaaaaa", name: "Morning digest", script: "digest.sh", enabled: true };
  // A bare list holding the managed job: removed, the resident's job kept (Hermes then saves the store canonical).
  writeFileSync(join(home, "cron", "jobs.json"), JSON.stringify([resident, managedJob]));
  expect(stage(alone).status).toBe(0);
  expect(jobs()).toEqual([resident]);
  expect(existsSync(join(home, "scripts", ZZZ_JOB_SCRIPT))).toBe(false);
  // An unloadable store that names the managed job (as written, or with Python's ensure_ascii em dash) may hold one
  // that cannot be confirmed gone: the stage fails loudly, and changes nothing in the store.
  for (const text of [`{"jobs": [{"name": "${ZZZ_JOB_NAME}"`, '{"jobs": [{"name": "Edge \\u2014 zzz pairs", "x": NaN}]}']) {
    writeFileSync(join(home, "cron", "jobs.json"), text);
    expect(stage(alone).status).toBe(1);
    expect(stage(alone, ["--verify"]).status).toBe(1);
    expect(readFileSync(join(home, "cron", "jobs.json"), "utf8")).toBe(text);
  }
});

test("review-b N2: with the gate on, every jobs.json shape Hermes loads is handled (bare list, id-keyed map, BOM, control characters)", () => {
  const resident = { id: "aaaaaaaaaaaa", name: "Morning digest", script: "digest.sh", enabled: true };
  const stores = {
    "empty bare list": "[]",
    "bare list": JSON.stringify([resident]),
    "id-keyed map": JSON.stringify({ jobs: { aaaaaaaaaaaa: { name: resident.name, script: resident.script, enabled: true } } }),
    "object without jobs": "{}",
    "BOM": "﻿" + JSON.stringify({ jobs: [resident] }),
    "raw control character in a string": `{"jobs": [{"id": "aaaaaaaaaaaa", "name": "Morning\tdigest", "script": "digest.sh", "enabled": true}]}`,
  };
  for (const [label, text] of Object.entries(stores)) {
    const { home, stage, jobs } = fakeBox();
    mkdirSync(join(home, "cron"));
    writeFileSync(join(home, "cron", "jobs.json"), text);
    expect(`${label}: ${stage(projection).status}`).toBe(`${label}: 0`);
    const managedJobs = jobs().filter((job: { name: string }) => job.name === ZZZ_JOB_NAME);
    expect(managedJobs).toHaveLength(1);
    expect(`${label}: ${stage(projection, ["--verify"]).status}`).toBe(`${label}: 0`);
  }
  // Hermes refuses any other top-level shape, and so does the installer with the gate on (fail closed, stage fails).
  const { home, stage } = fakeBox();
  mkdirSync(join(home, "cron"));
  for (const text of ["{not json", "\"jobs\"", "{\"jobs\": 7}"]) {
    writeFileSync(join(home, "cron", "jobs.json"), text);
    expect(stage(projection).status).toBe(1);
    expect(readFileSync(join(home, "cron", "jobs.json"), "utf8")).toBe(text);
    expect(existsSync(join(home, "scripts", ZZZ_JOB_SCRIPT))).toBe(false);
  }
});

test("review-b N3: --verify checks the job record: exactly the installer's job while the pair is projected, none once it is not", () => {
  const { home, stage, jobs } = fakeBox();
  expect(stage(projection).status).toBe(0);
  const good = readFileSync(join(home, "cron", "jobs.json"), "utf8");
  const verify = (value: unknown) => {
    const before = snapshot(home);
    const result = stage(value, ["--verify"], HERMES_GONE(home));
    expect(snapshot(home)).toEqual(before);
    return result.status;
  };
  expect(verify(projection)).toBe(0);
  const job = jobs()[0];
  const variants: [string, unknown][] = [
    ["job gone", { jobs: [] }], ["job disabled", { jobs: [{ ...job, enabled: false }] }],
    ["toolsets widened", { jobs: [{ ...job, enabled_toolsets: ["all"] }] }], ["no_agent", { jobs: [{ ...job, no_agent: true }] }],
    ["another script", { jobs: [{ ...job, script: "other.sh" }] }], ["duplicate", { jobs: [job, { ...job, id: "bbbbbbbbbbbb" }] }],
  ];
  for (const [label, doc] of variants) {
    writeFileSync(join(home, "cron", "jobs.json"), JSON.stringify(doc));
    expect(`${label}: ${verify(projection)}`).toBe(`${label}: 1`);
  }
  writeFileSync(join(home, "cron", "jobs.json"), good);
  expect(verify(projection)).toBe(0);
  // The shim the job runs: missing or altered is a mismatch.
  const shim = join(home, "scripts", ZZZ_JOB_SCRIPT);
  const shimBytes = readFileSync(shim);
  writeFileSync(shim, "#!/bin/sh\necho altered\n");
  expect(verify(projection)).toBe(1);
  rmSync(shim);
  expect(verify(projection)).toBe(1);
  writeFileSync(shim, shimBytes, { mode: 0o700 });
  expect(verify(projection)).toBe(0);
  // Gate off: a lingering managed job (files and state already gone) is removal pending; so is leftover state alone.
  expect(stage(alone).status).toBe(0);
  expect(verify(alone)).toBe(0);
  writeFileSync(join(home, "cron", "jobs.json"), good);
  expect(verify(alone)).toBe(1);
  writeFileSync(join(home, "cron", "jobs.json"), JSON.stringify({ jobs: [] }));
  expect(verify(alone)).toBe(0);
  seedState(home);
  expect(verify(alone)).toBe(1);
  expect(stage(alone).status).toBe(0);
  expect(verify(alone)).toBe(0);
});

test("review-b N3: a box with no projection left heals a lingering job and state (the stateless branch), and verify sees it", () => {
  const { home, stage, jobs } = fakeBox();
  expect(stage(projection).status).toBe(0);
  seedState(home);
  // An interrupted uninstall: the projection and every owned skill are gone, the job, shim and cursor state linger.
  for (const path of ["mini-apps.json", "skills/zzzbot/SKILL.md", "skills/zzzbot/prompts/participate.md", `skills/zzzbot/scripts/${ZZZ_JOB_SCRIPT}`])
    rmSync(join(home, path));
  const empty = { version: 1, apps: [] };
  expect(jobs()).toHaveLength(1);
  expect(stage(empty, ["--verify"]).status).toBe(1);
  expect(jobs()).toHaveLength(1);
  expect(stage(empty).status).toBe(0);
  expectOff(home, jobs);
  expect(existsSync(join(home, "mini-apps.json"))).toBe(false);
  expect(stage(empty, ["--verify"]).status).toBe(0);
});
