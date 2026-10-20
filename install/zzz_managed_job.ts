/** Installer-owned Hermes job for enabled zzzbot projections. No resident-created cron. */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hermesBin, hermesExecEnv } from "./hermes_cli";
import { hermesAvailable } from "./install_index";

export const ZZZ_JOB_NAME = "Edge — zzz pairs";
export const ZZZ_JOB_SCRIPT = "agentvillage_zzz_pairs.sh";
export const ZZZ_JOB_SCHEDULE = "*/10 * * * *";
const PROMPT = "skills/zzzbot/prompts/participate.md";
const SCRIPT = "skills/zzzbot/scripts/agentvillage_zzz_pairs.sh";

type Job = { id?: unknown; name?: unknown; script?: unknown; enabled?: unknown };
const ID = /^[0-9a-f]{12}$/;

function plainFile(path: string): boolean {
  try {
    const meta = lstatSync(path);
    if (!meta.isFile() || meta.isSymbolicLink()) throw new Error("zzz_shim_invalid");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function scriptsDir(home: string): string {
  const path = join(home, "scripts");
  if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()))
    throw new Error("zzz_shim_dir_invalid");
  return path;
}

function jobs(home: string): Job[] {
  try {
    const folder = join(home, "cron");
    if (existsSync(folder) && (!lstatSync(folder).isDirectory() || lstatSync(folder).isSymbolicLink()))
      throw new Error("jobs-folder-invalid");
    const path = join(home, "cron", "jobs.json");
    if (!plainFile(path)) return [];
    const doc = JSON.parse(readFileSync(path, "utf8"));
    if (!doc || !Array.isArray(doc.jobs)) throw new Error("jobs-invalid");
    return doc.jobs;
  } catch { throw new Error("zzz_jobs_unreadable"); }
}

/** Reconcile only the installer-owned job; the projection remains app authority. */
export function reconcileZzzManagedJob(home: string, installed: boolean): void {
  const current = jobs(home).filter(job => job.name === ZZZ_JOB_NAME);
  const bin = hermesBin();
  const env = hermesExecEnv();
  if (!installed) {
    if (current.length && !hermesAvailable(bin, 5_000, env)) throw new Error("zzz_hermes_missing");
    for (const job of current) {
      if (typeof job.id !== "string" || !ID.test(job.id)) throw new Error("zzz_job_invalid");
      execFileSync(bin, ["cron", "remove", job.id], { env, stdio: "ignore", timeout: 30_000 });
    }
    const shim = join(scriptsDir(home), ZZZ_JOB_SCRIPT);
    if (plainFile(shim)) unlinkSync(shim);
    return;
  }
  if (!hermesAvailable(bin, 5_000, env)) throw new Error("zzz_hermes_missing");
  if (current.length > 1) throw new Error("zzz_job_duplicate");
  const prompt = readFileSync(join(home, PROMPT), "utf8").trimEnd();
  const script = readFileSync(join(home, SCRIPT));
  const shim = join(scriptsDir(home), ZZZ_JOB_SCRIPT);
  plainFile(shim);
  // The mini-app helper stages the reviewed script before publishing authority.
  mkdirSync(scriptsDir(home), { recursive: true });
  writeFileSync(shim, script, { mode: 0o700 });
  chmodSync(shim, 0o700);
  if (current.length) {
    const job = current[0];
    if (typeof job.id !== "string" || !ID.test(job.id)) throw new Error("zzz_job_invalid");
    // This exact managed shape is reasserted on a stage; schedule stays with the job.
    execFileSync(bin, ["cron", "edit", job.id, "--prompt", prompt, "--script", ZZZ_JOB_SCRIPT,
      "--agent", "--failure-deliver", "local"], { env, stdio: "ignore", timeout: 30_000 });
    if (job.enabled !== true) execFileSync(bin, ["cron", "resume", job.id], { env, stdio: "ignore", timeout: 30_000 });
  } else {
    execFileSync(bin, ["cron", "create", ZZZ_JOB_SCHEDULE, prompt, "--name", ZZZ_JOB_NAME,
      "--script", ZZZ_JOB_SCRIPT, "--failure-deliver", "local", "--workdir", home],
      { env, stdio: "ignore", timeout: 30_000 });
  }
  const after = jobs(home).filter(job => job.name === ZZZ_JOB_NAME);
  if (after.length !== 1 || after[0].script !== ZZZ_JOB_SCRIPT || after[0].enabled !== true)
    throw new Error("zzz_job_not_confirmed");
}
