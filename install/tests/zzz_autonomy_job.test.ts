import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REVIEWED_MINI_APPS } from "../install_miniapps";
import { AUTONOMY_FILES, AUTONOMY_GATE, AUTONOMY_JOB_NAME, AUTONOMY_JOB_SCRIPT,
  AUTONOMY_SHIPPED, autonomyMarkers, autonomySchedule } from "../zzz_autonomy_job";
import { createHash } from "node:crypto";

const repo = join(import.meta.dir, "../..");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });
const zzzbot = REVIEWED_MINI_APPS.find(app=>app.id==="zzzbot")!;
const autonomy = REVIEWED_MINI_APPS.find(app=>app.id===AUTONOMY_GATE)!;
const pair = REVIEWED_MINI_APPS.find(app=>app.id==="zzz-bridge")!;
const token = "avb_"+"a".repeat(43);
function box() {
  const home=mkdtempSync(join(tmpdir(),"av-zzz-autonomy-")); roots.push(home);
  const python=join(home,"venv/bin/python"), hermes=join(home,"bin/hermes");
  mkdirSync(join(home,"venv/bin"),{recursive:true});mkdirSync(join(home,"bin"));
  mkdirSync(join(home,"hermes_cli"));
  writeFileSync(join(home,"hermes_cli/main.py"),"# bound fake\n");
  writeFileSync(hermes,`#!/usr/bin/env bash\nunset PYTHONPATH\nunset PYTHONHOME\nexec "${python}" "${join(home,"hermes_cli/main.py")}" "$@"\n`);
  writeFileSync(python,`#!/usr/bin/env bash\nif [ "$1" = "-c" ]; then\n shift 2\n exec "${process.execPath}" "${join(import.meta.dir,"fake_hermes_job_python.ts")}" "$@"\nfi\nshift\nexec "${process.execPath}" "${join(import.meta.dir,"fake_hermes.ts")}" "$@"\n`);
  chmodSync(hermes,0o755);chmodSync(python,0o755);
  writeFileSync(join(home,"village-bridge.json"),JSON.stringify({origin:"https://agents.edgecity.live",token,
    expiresAt:"2099-01-01T00:00:00Z"}));
  const stage=(apps: readonly unknown[],args:string[]=[],extraEnv:Record<string,string>={})=>spawnSync(process.execPath,
    ["--no-env-file","--no-install","install/install_miniapps.ts",...args],{cwd:repo,
      input:JSON.stringify({version:1,apps}),env:{...process.env,HERMES_HOME:home,HERMES_BIN:hermes,...extraEnv},encoding:"utf8"});
  const jobs=()=>JSON.parse(readFileSync(join(home,"cron/jobs.json"),"utf8")).jobs as Array<Record<string,unknown>>;
  return {home,stage,jobs};
}

test("reviewed event gate is independent of the private-pair gate and owns one exact no-agent job",()=>{
  expect(autonomy).toEqual({id:AUTONOMY_GATE,version:"1.0.0",operations:[],skills:[]});
  const {home,stage,jobs}=box();
  expect(stage([zzzbot]).status).toBe(0);
  expect(existsSync(join(home,"cron/jobs.json"))).toBe(false);
  expect(stage([zzzbot,pair]).status).toBe(0);
  expect(jobs().map(job=>job.name)).toEqual(["Edge — zzz pairs"]);
  expect(stage([zzzbot,pair,autonomy]).status).toBe(0);
  expect(jobs().map(job=>job.name).sort()).toEqual(["Edge — zzz event autonomy","Edge — zzz pairs"]);
  const job=jobs().find(job=>job.name===AUTONOMY_JOB_NAME)!;
  expect(job).toMatchObject({script:AUTONOMY_JOB_SCRIPT,no_agent:true,enabled:true,enabled_toolsets:["no_mcp"],
    schedule:{kind:"cron",expr:autonomySchedule(token)}});
  expect(readFileSync(join(home,"scripts",AUTONOMY_JOB_SCRIPT))).toEqual(readFileSync(join(repo,"skills/zzzbot/scripts",AUTONOMY_JOB_SCRIPT)));
  expect(autonomyMarkers(home)).toBe(true);
  expect(stage([zzzbot,pair,autonomy],["--verify"]).status).toBe(0);
  expect(stage([zzzbot,pair]).status).toBe(0);
  expect(jobs().map(job=>job.name)).toEqual(["Edge — zzz pairs"]);
  expect(existsSync(join(home,"scripts",AUTONOMY_JOB_SCRIPT))).toBe(false);
  expect(autonomyMarkers(home)).toBe(false);
  expect(stage([zzzbot,pair],["--verify"]).status).toBe(0);
});

test("gate without zzzbot stages no job and malformed gate fails closed",()=>{
  const {home,stage}=box();
  expect(stage([autonomy]).status).toBe(0);
  expect(existsSync(join(home,"cron/jobs.json"))).toBe(false);
  expect(stage([zzzbot,{...autonomy,operations:["zzz.reply"]}]).status).toBe(1);
  expect(autonomyMarkers(home)).toBe(false);
});

test("first shipped bytes are pinned and teardown preserves resident replacement",()=>{
  for (const relative of AUTONOMY_FILES) {
    const digest=createHash("sha256").update(readFileSync(join(repo,"skills/zzzbot",relative))).digest("hex");
    expect(AUTONOMY_SHIPPED[relative]).toContain(digest);
  }
  const {home,stage,jobs}=box();
  expect(stage([zzzbot,autonomy]).status).toBe(0);
  const shim=join(home,"scripts",AUTONOMY_JOB_SCRIPT);
  writeFileSync(shim,"resident replacement");
  expect(stage([zzzbot]).status).toBe(0);
  expect(jobs()).toEqual([]);
  expect(readFileSync(shim,"utf8")).toBe("resident replacement");
});

test("failed stage withdraws only the autonomy gate before tearing down its job",()=>{
  const {home,stage,jobs}=box();
  expect(stage([zzzbot,pair,autonomy]).status).toBe(0);
  expect(stage([zzzbot,pair,{...autonomy,skills:["unreviewed"]}]).status).toBe(1);
  expect(JSON.parse(readFileSync(join(home,"mini-apps.json"),"utf8")).apps.map((app:{id:string})=>app.id))
    .toEqual(["zzzbot","zzz-bridge"]);
  // The existing failClosedZzz also removes its pair job on any failed stage.
  expect(jobs()).toEqual([]);
  expect(existsSync(join(home,"scripts",AUTONOMY_JOB_SCRIPT))).toBe(false);
});

test("failed Hermes teardown still withdraws the gate and the owned executable",()=>{
  const {home,stage,jobs}=box();
  expect(stage([zzzbot,autonomy]).status).toBe(0);
  const failing=join(home,"bin","fail-hermes");
  writeFileSync(failing,"#!/usr/bin/env bash\nexit 1\n");chmodSync(failing,0o755);
  expect(stage([zzzbot,{...autonomy,skills:["unreviewed"]}],[],{HERMES_BIN:failing}).status).toBe(1);
  expect(JSON.parse(readFileSync(join(home,"mini-apps.json"),"utf8")).apps.map((app:{id:string})=>app.id))
    .toEqual(["zzzbot"]);
  expect(existsSync(join(home,"scripts",AUTONOMY_JOB_SCRIPT))).toBe(false);
  // The stale job record is inert: the script and projection gate are gone.
  expect(jobs().map(job=>job.name)).toEqual([AUTONOMY_JOB_NAME]);
});
