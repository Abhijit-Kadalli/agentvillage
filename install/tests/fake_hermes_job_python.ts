/** Local-only stand-in for the Hermes Python job store API invoked by the installer. */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const home = process.env.HERMES_HOME!;
const path = join(home, "cron", "jobs.json");
const jobs: Record<string, any>[] = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).jobs : [];
const request = JSON.parse(await Bun.stdin.text());
if (request.action === "remove") {
  const index = jobs.findIndex(job => job.id === request.id && job.name === request.name);
  if (index < 0) process.exit(1);
  jobs.splice(index, 1);
} else {
  const old = jobs.find(job => job.id === request.id);
  if (request.id && (!old || old.name !== request.name)) process.exit(1);
  const job = old ?? { id: randomBytes(6).toString("hex"), name: request.name };
  Object.assign(job, { prompt: request.prompt, script: request.script,
    enabled_toolsets: request.toolsets, enabled: true, no_agent: false, workdir: request.home });
  if (!old) jobs.push(job);
}
mkdirSync(join(home, "cron"), { recursive: true });
writeFileSync(path, JSON.stringify({ jobs }));
