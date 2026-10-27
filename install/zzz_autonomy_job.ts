/** Separate, projection-gated no-agent ZZZ event job. No pair-gate dependency. */
import { chmodSync, constants, lstatSync, mkdirSync, openSync, readFileSync, closeSync, fstatSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { hermesBin, hermesExecEnv } from "./hermes_cli";
import { hermesAvailable } from "../skills/index-network/scripts/hermes-cli";
import { jobApi, jobPython, parseHermesJobs } from "./zzz_managed_job";

export const AUTONOMY_GATE = "zzz-autonomy-runner";
export const AUTONOMY_JOB_NAME = "Edge — zzz event autonomy";
export const AUTONOMY_JOB_SCRIPT = "zzz_autonomy_runner.py";
export const AUTONOMY_FILES = ["scripts/zzz_autonomy_runner.py", "prompts/autonomy.md"] as const;
const ID = /^[0-9a-f]{12}$/;
const TOKEN = /^avb_[A-Za-z0-9_-]{43}$/;
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const source = (relative: string) => readFileSync(join(import.meta.dir, "..", "skills", "zzzbot", relative));

/** First shipped version. Append old fixed digests before changing shipped files in a later release. */
export const AUTONOMY_SHIPPED = {
  "scripts/zzz_autonomy_runner.py": ["a4943bc125c0792b57df0c4254977983226e37bf3864fde34b0f7c0bc9feb393"],
  "prompts/autonomy.md": ["93b8442797de1957ac5e64eb7477e1288601654fdaccb56fc4791f0bfd608587"],
} as const;

function ownedFile(path: string, relative: typeof AUTONOMY_FILES[number]): "absent" | "ours" | "not_ours" {
  let meta;
  try { meta = lstatSync(path); } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "not_ours"; }
  if (!meta.isFile() || meta.size > 65536) return "not_ours";
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const actual = fstatSync(fd);
    if (!actual.isFile() || actual.ino !== meta.ino || actual.dev !== meta.dev) return "not_ours";
    return (AUTONOMY_SHIPPED[relative] as readonly string[]).includes(sha(readFileSync(fd))) ? "ours" : "not_ours";
  } catch { return "not_ours"; } finally { if (fd !== undefined) closeSync(fd); }
}

function realDir(home: string, ...parts: string[]): string | null {
  let path = home;
  for (const part of parts) {
    path = join(path, part);
    try { const meta = lstatSync(path); if (!meta.isDirectory() || meta.isSymbolicLink()) return null; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  return path;
}

export function autonomyMarkers(home: string): boolean {
  const scripts = realDir(home, "scripts");
  const skill = realDir(home, "skills", "zzzbot");
  const state = realDir(home, "zzzbot");
  return Boolean((scripts && ownedFile(join(scripts, AUTONOMY_JOB_SCRIPT), AUTONOMY_FILES[0]) === "ours") ||
    (state && (() => { try { return lstatSync(join(state, "autonomy-run.lock")).isFile(); } catch { return false; } })()) ||
    (skill && AUTONOMY_FILES.some(relative => {
      const dir = realDir(skill, ...relative.split("/").slice(0, -1));
      return dir && ownedFile(join(dir, relative.split("/").at(-1)!), relative) === "ours";
    })));
}

export function removeAutonomyState(home: string): void {
  const state = realDir(home, "zzzbot");
  if (!state) return;
  const path = join(state, "autonomy-run.lock");
  try { if (lstatSync(path).isFile()) unlinkSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export function removeAutonomyFiles(home: string): void {
  const skill = realDir(home, "skills", "zzzbot");
  if (!skill) return;
  for (const relative of AUTONOMY_FILES) {
    const dir = realDir(skill, ...relative.split("/").slice(0, -1));
    if (dir) { const path = join(dir, relative.split("/").at(-1)!); if (ownedFile(path, relative) === "ours") unlinkSync(path); }
  }
}

export function removeAutonomyShim(home: string): void {
  const dir=realDir(home,"scripts");
  if (!dir) return;
  const path=join(dir,AUTONOMY_JOB_SCRIPT);
  if (ownedFile(path,AUTONOMY_FILES[0])==="ours") unlinkSync(path);
}

function store(home: string) {
  const folder = realDir(home, "cron");
  if (!folder) return { jobs: [] as Record<string, unknown>[], named: false };
  const path = join(folder, "jobs.json");
  let raw: string;
  let fd: number | undefined;
  try {
    const meta=lstatSync(path);
    if (!meta.isFile() || meta.isSymbolicLink() || meta.size>1024*1024) throw new Error("zzz_autonomy_jobs_shape");
    fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const actual=fstatSync(fd);
    if (!actual.isFile() || actual.ino!==meta.ino || actual.dev!==meta.dev) throw new Error("zzz_autonomy_jobs_shape");
    raw = readFileSync(fd,"utf8");
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { jobs: [] as Record<string, unknown>[], named: false }; throw error; }
  finally { if (fd!==undefined) closeSync(fd); }
  const named = /Edge (?:—|\\u2014) zzz event autonomy/.test(raw);
  const parsed = parseHermesJobs(raw);
  if (!parsed) { if (named) throw new Error("zzz_autonomy_jobs_unreadable"); return { jobs: [] as Record<string, unknown>[], named: false }; }
  const namedJobs=parsed.filter(job=>!!job && typeof job==="object" && job.name===AUTONOMY_JOB_NAME);
  const jobs=namedJobs.filter((job): job is Record<string, unknown> => !!job && typeof job === "object" &&
    job.name === AUTONOMY_JOB_NAME && job.script === AUTONOMY_JOB_SCRIPT &&
    job.prompt === source(AUTONOMY_FILES[1]).toString("utf8").trimEnd() && job.no_agent === true &&
    JSON.stringify(job.enabled_toolsets) === '["no_mcp"]');
  return {jobs,named,conflict:namedJobs.length!==jobs.length};
}

export function autonomySchedule(token: string): string {
  if (!TOKEN.test(token)) throw new Error("zzz_autonomy_bridge_token");
  const phase = createHash("sha256").update(token).digest()[0] % 5;
  return `${phase}-59/5 * * * *`;
}

function bridgeToken(home: string): string {
  const path = join(home, "village-bridge.json");
  const meta = lstatSync(path);
  if (!meta.isFile() || meta.isSymbolicLink() || meta.size > 2048) throw new Error("zzz_autonomy_bridge_config");
  let fd: number | undefined;
  let data: unknown;
  try {
    fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const actual=fstatSync(fd);
    if (!actual.isFile() || actual.ino!==meta.ino || actual.dev!==meta.dev) throw new Error("zzz_autonomy_bridge_config");
    data=JSON.parse(readFileSync(fd,"utf8"));
  } finally { if (fd!==undefined) closeSync(fd); }
  const token = data && typeof data === "object" ? (data as {token?: unknown}).token : null;
  if (typeof token !== "string" || !TOKEN.test(token)) throw new Error("zzz_autonomy_bridge_config");
  return token;
}

function confirmed(job: Record<string, unknown>, schedule: string, prompt: string): boolean {
  const sch = job.schedule as {kind?: unknown;expr?: unknown} | undefined;
  const repeat = job.repeat as {times?: unknown} | undefined;
  const empty = (value: unknown) => value == null || value === "" || (Array.isArray(value) && value.length === 0);
  return typeof job.id === "string" && ID.test(job.id) && job.name === AUTONOMY_JOB_NAME &&
    job.script === AUTONOMY_JOB_SCRIPT && job.prompt === prompt && job.enabled === true && job.no_agent === true &&
    JSON.stringify(job.enabled_toolsets) === '["no_mcp"]' && job.deliver === "local" && job.failure_deliver === "local" &&
    !job.workdir && empty(job.skills) && empty(job.skill) && empty(job.context_from) && !job.monitor_script && !job.monitor_url &&
    sch?.kind === "cron" && sch.expr === schedule && repeat?.times === null;
}

export function verifyAutonomyJob(home: string, installed: boolean, script: Buffer | null): void {
  const jobs = store(home).jobs;
  const dir = realDir(home, "scripts");
  const shim = dir ? join(dir, AUTONOMY_JOB_SCRIPT) : null;
  if (!installed) {
    if (jobs.length || (shim && ownedFile(shim, AUTONOMY_FILES[0]) === "ours")) throw new Error("zzz_autonomy_removal_pending");
    return;
  }
  const prompt = source(AUTONOMY_FILES[1]).toString("utf8").trimEnd();
  if (jobs.length !== 1 || !confirmed(jobs[0], autonomySchedule(bridgeToken(home)), prompt) ||
      !shim || !script || ownedFile(shim, AUTONOMY_FILES[0]) !== "ours" || !readFileSync(shim).equals(script))
    throw new Error("zzz_autonomy_job_not_confirmed");
}

export function reconcileAutonomyJob(home: string, installed: boolean): void {
  const current = store(home), jobs=current.jobs;
  if (!installed) {
    if (jobs.length) {
      const bin = hermesBin();
      if (!hermesAvailable(bin, 15000, hermesExecEnv())) throw new Error("zzz_autonomy_hermes_missing");
      const python = jobPython(bin);
      for (const job of jobs) {
        if (typeof job.id !== "string" || !ID.test(job.id)) throw new Error("zzz_autonomy_job_invalid");
        jobApi(python, home, {action:"remove",id:job.id,name:AUTONOMY_JOB_NAME});
      }
      if (store(home).jobs.length) throw new Error("zzz_autonomy_removal_pending");
    }
    removeAutonomyShim(home);
    return;
  }
  if (current.conflict) throw new Error("zzz_autonomy_job_name_conflict");
  if (jobs.length > 1) throw new Error("zzz_autonomy_duplicate_job");
  const bin = hermesBin();
  if (!hermesAvailable(bin, 15000, hermesExecEnv())) throw new Error("zzz_autonomy_hermes_missing");
  const python = jobPython(bin);
  const prompt = source(AUTONOMY_FILES[1]).toString("utf8").trimEnd();
  const script = source(AUTONOMY_FILES[0]);
  const schedule = autonomySchedule(bridgeToken(home));
  const dir = realDir(home, "scripts");
  if (!dir) {
    try { lstatSync(join(home,"scripts")); throw new Error("zzz_autonomy_scripts_invalid"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code!=="ENOENT") throw error; }
  }
  const scripts = join(home, "scripts");
  mkdirSync(scripts, {recursive:true,mode:0o700});
  const shim = join(scripts, AUTONOMY_JOB_SCRIPT);
  if (ownedFile(shim, AUTONOMY_FILES[0]) === "not_ours") throw new Error("zzz_autonomy_shim_not_ours");
  writeFileSync(shim, script, {mode:0o700}); chmodSync(shim,0o700);
  const id = jobs[0]?.id;
  if (id !== undefined && (typeof id !== "string" || !ID.test(id))) throw new Error("zzz_autonomy_job_invalid");
  jobApi(python, home, {action:"install",...(id?{id}:{}),name:AUTONOMY_JOB_NAME,prompt,
    script:AUTONOMY_JOB_SCRIPT,schedule,toolsets:["no_mcp"]});
  verifyAutonomyJob(home,true,script);
}
