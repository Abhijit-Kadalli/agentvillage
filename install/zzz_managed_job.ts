/** Installer-owned Hermes job for enabled zzzbot projections. No resident-created cron. */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { hermesBin, hermesExecEnv } from "./hermes_cli";
import { hermesAvailable } from "./install_index";

export const ZZZ_JOB_NAME = "Edge — zzz pairs";
export const ZZZ_JOB_SCRIPT = "agentvillage_zzz_pairs.sh";
export const ZZZ_JOB_SCHEDULE = "*/10 * * * *";
export const ZZZ_JOB_TOOLSETS = ["village", "no_mcp"] as const;
const PROMPT = "skills/zzzbot/prompts/participate.md";
const SCRIPT = "skills/zzzbot/scripts/agentvillage_zzz_pairs.sh";

type Job = { id?: unknown; name?: unknown; script?: unknown; enabled?: unknown; enabled_toolsets?: unknown; no_agent?: unknown };
const ID = /^[0-9a-f]{12}$/;

// Hermes v2026.9.24's CLI cannot set enabled_toolsets. Its cron.jobs API is
// the same locked job store used by the cronjob tool. Create paused with the
// exact allowlist, then resume; a failure leaves the job disabled.
const JOB_API = String.raw`
import json, sys
from cron.jobs import create_job, get_job, pause_job, resume_job, remove_job, update_job
r = json.load(sys.stdin)
if r['action'] == 'remove':
    old = get_job(r['id'])
    if not old or old.get('name') != r['name']:
        raise RuntimeError('zzz_job_mismatch')
    pause_job(r['id'])
    if not remove_job(r['id']):
        raise RuntimeError('zzz_job_remove_failed')
else:
    if r.get('id'):
        old = get_job(r['id'])
        if not old or old.get('name') != r['name']:
            raise RuntimeError('zzz_job_mismatch')
        pause_job(r['id'])
        safe = (old.get('script') == r['script'] and old.get('no_agent') is not True
            and old.get('enabled_toolsets') == r['toolsets'])
        if safe:
            job = update_job(r['id'], {'prompt': r['prompt'], 'script': r['script'],
                'enabled_toolsets': r['toolsets'], 'no_agent': False,
                'failure_deliver': 'local', 'workdir': r['home']})
        else:
            # A running agent retains its tool snapshot. Removal invalidates
            # that old cron ID at the native gate before the new job resumes.
            if not remove_job(r['id']):
                raise RuntimeError('zzz_unsafe_job_remove_failed')
            job = create_job(prompt=r['prompt'], schedule=r['schedule'], name=r['name'],
                script=r['script'], enabled_toolsets=r['toolsets'], workdir=r['home'],
                failure_deliver='local', paused=True, paused_reason='Configuring ZZZ tool scope')
    else:
        job = create_job(prompt=r['prompt'], schedule=r['schedule'], name=r['name'],
            script=r['script'], enabled_toolsets=r['toolsets'], workdir=r['home'],
            failure_deliver='local', paused=True, paused_reason='Configuring ZZZ tool scope')
    if not job or job.get('enabled_toolsets') != r['toolsets'] or job.get('enabled'):
        raise RuntimeError('zzz_job_scope_failed')
    resumed = resume_job(job['id'])
    if not resumed or resumed.get('enabled_toolsets') != r['toolsets'] or resumed.get('enabled') is not True:
        pause_job(job['id'])
        raise RuntimeError('zzz_job_resume_failed')
`;

function jobPython(bin: string): string {
  if (!isAbsolute(bin)) throw new Error("zzz_hermes_bin_unbound");
  const resolved = realpathSync(bin);
  const source = readFileSync(resolved, "utf8");
  // install.sh's public launcher is a bash wrapper, even when an unrelated
  // python happens to sit beside it. Bind to the interpreter in its one exec.
  if (source.startsWith("#!/usr/bin/env bash\n")) {
    const wrapper = /^#!\/usr\/bin\/env bash\nunset PYTHONPATH\nunset PYTHONHOME\nexec "(\/[^"\n]+\/python(?:[0-9.]*)?)" "(\/[^"\n]+)" "\$@"\n?$/.exec(source);
    if (!wrapper || !/(?:\/hermes|\/hermes_cli\/main\.py)$/.test(wrapper[2])
        || !existsSync(wrapper[1]) || !existsSync(wrapper[2]))
      throw new Error("zzz_hermes_wrapper_unbound");
    return wrapper[1];
  }
  // pipx/uv entrypoints can live outside their venv; their absolute shebang
  // still selects the same interpreter. Never search PATH for another Python.
  const shebang = source.split("\n", 1)[0];
  const match = /^#!(\/\S*\/python(?:[0-9.]*)?)$/.exec(shebang);
  if (match && existsSync(match[1])) return match[1];
  const beside = join(dirname(resolved), "python");
  if (/(?:^|\/)\.?venv\/bin\/[^/]+$/.test(resolved) && existsSync(beside)) return beside;
  throw new Error("zzz_hermes_python_missing");
}

function jobApi(python: string, home: string, request: Record<string, unknown>): void {
  const env = { ...hermesExecEnv(), HERMES_HOME: home };
  delete env.PYTHONPATH;
  delete env.PYTHONHOME;
  execFileSync(python, ["-c", JOB_API], {
    env, input: JSON.stringify(request),
    stdio: ["pipe", "ignore", "ignore"], timeout: 30_000,
  });
}

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
    const python = current.length ? jobPython(bin) : null;
    for (const job of current) {
      if (typeof job.id !== "string" || !ID.test(job.id)) throw new Error("zzz_job_invalid");
      jobApi(python!, home, { action: "remove", id: job.id, name: ZZZ_JOB_NAME });
    }
    const shim = join(scriptsDir(home), ZZZ_JOB_SCRIPT);
    if (plainFile(shim)) unlinkSync(shim);
    return;
  }
  if (!hermesAvailable(bin, 5_000, env)) throw new Error("zzz_hermes_missing");
  if (current.length > 1) throw new Error("zzz_job_duplicate");
  const python = jobPython(bin);
  const prompt = readFileSync(join(home, PROMPT), "utf8").trimEnd();
  const script = readFileSync(join(home, SCRIPT));
  const shim = join(scriptsDir(home), ZZZ_JOB_SCRIPT);
  plainFile(shim);
  // The mini-app helper stages the reviewed script before publishing authority.
  mkdirSync(scriptsDir(home), { recursive: true });
  writeFileSync(shim, script, { mode: 0o700 });
  chmodSync(shim, 0o700);
  const id = current[0]?.id;
  if (id !== undefined && (typeof id !== "string" || !ID.test(id))) throw new Error("zzz_job_invalid");
  jobApi(python, home, { action: "install", ...(id ? { id } : {}), name: ZZZ_JOB_NAME,
    prompt, script: ZZZ_JOB_SCRIPT, schedule: ZZZ_JOB_SCHEDULE,
    toolsets: [...ZZZ_JOB_TOOLSETS], home });
  const after = jobs(home).filter(job => job.name === ZZZ_JOB_NAME);
  if (after.length !== 1 || after[0].script !== ZZZ_JOB_SCRIPT || after[0].enabled !== true
      || after[0].no_agent === true || JSON.stringify(after[0].enabled_toolsets) !== JSON.stringify(ZZZ_JOB_TOOLSETS))
    throw new Error("zzz_job_not_confirmed");
}
