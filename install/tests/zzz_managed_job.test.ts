import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
