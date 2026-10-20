import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileMiniApps, REVIEWED_MINI_APPS } from "../install_miniapps";
import { reconcileZzzManagedJob, ZZZ_JOB_NAME, ZZZ_JOB_SCRIPT, ZZZ_JOB_TOOLSETS } from "../zzz_managed_job";

const fake = join(import.meta.dir, "fake_hermes.ts");
const fakeJobPython = join(import.meta.dir, "fake_hermes_job_python.ts");
const saved = { HERMES_HOME: process.env.HERMES_HOME, HERMES_BIN: process.env.HERMES_BIN };
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("installed ZZZ projection owns one Hermes agent job; revocation removes it", () => {
  const home = mkdtempSync(join(tmpdir(), "av-zzz-job-"));
  roots.push(home);
  const bin = join(home, "hermes");
  writeFileSync(bin, `#!/usr/bin/env bash\nexec "${process.execPath}" "${fake}" "$@"\n`);
  chmodSync(bin, 0o755);
  const python = join(home, "python");
  writeFileSync(python, `#!/usr/bin/env bash\nexec "${process.execPath}" "${fakeJobPython}" "$@"\n`);
  chmodSync(python, 0o755);
  process.env.HERMES_HOME = home;
  process.env.HERMES_BIN = bin;
  const projection = { version: 1, apps: [REVIEWED_MINI_APPS.find(app => app.id === "zzzbot")!] };
  reconcileMiniApps(projection, home);
  reconcileZzzManagedJob(home, true);
  const jobs = () => JSON.parse(readFileSync(join(home, "cron", "jobs.json"), "utf8")).jobs;
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
  reconcileMiniApps({ version: 1, apps: [] }, home);
  reconcileZzzManagedJob(home, false);
  expect(jobs()).toHaveLength(0);
  expect(existsSync(join(home, "scripts", ZZZ_JOB_SCRIPT))).toBe(false);
  expect(existsSync(join(home, "skills", "zzzbot", "prompts", "participate.md"))).toBe(false);
});
