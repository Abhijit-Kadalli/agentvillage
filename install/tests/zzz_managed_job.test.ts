import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  expect(existsSync(join(home, "skills", "zzzbot"))).toBe(false);
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
