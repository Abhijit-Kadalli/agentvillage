import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("a box holding the previous runner bytes upgrades to the current bytes, then tears down cleanly",()=>{
  const previous=readFileSync(join(import.meta.dir,"fixtures/zzz_autonomy_runner.ov528.py.fixture"));
  const current=readFileSync(join(repo,"skills/zzzbot/scripts",AUTONOMY_JOB_SCRIPT));
  const digest=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");
  expect(digest(previous)).toBe("0b59cecbea3f48dce41ce3adcbb6fd2ff7d530567b255148e204941cddd2fd87");
  expect(previous.equals(current)).toBe(false);
  expect(AUTONOMY_SHIPPED[AUTONOMY_FILES[0]]).toEqual([digest(previous),digest(current)]);
  const {home,stage,jobs}=box();
  expect(stage([zzzbot,autonomy]).status).toBe(0);
  const shim=join(home,"scripts",AUTONOMY_JOB_SCRIPT);
  // The box as the previous release left it: previous bytes in the shim and the staged skill copy.
  writeFileSync(shim,previous,{mode:0o700});
  const skillCopy=join(home,"skills/zzzbot/scripts",AUTONOMY_JOB_SCRIPT);
  if (existsSync(skillCopy)) writeFileSync(skillCopy,previous);
  expect(autonomyMarkers(home)).toBe(true);
  expect(stage([zzzbot,autonomy]).status).toBe(0);
  expect(readFileSync(shim).equals(current)).toBe(true);
  expect(jobs().map(job=>job.name)).toEqual([AUTONOMY_JOB_NAME]);
  expect(stage([zzzbot,autonomy],["--verify"]).status).toBe(0);
  // Teardown straight from the previous bytes also removes the shim and the job.
  writeFileSync(shim,previous,{mode:0o700});
  expect(stage([zzzbot]).status).toBe(0);
  expect(jobs()).toEqual([]);
  expect(existsSync(shim)).toBe(false);
  expect(autonomyMarkers(home)).toBe(false);
  expect(stage([zzzbot],["--verify"]).status).toBe(0);
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

test("failed Hermes teardown withdraws the gate, keeps the teardown pending, and the next stage removes the job",()=>{
  const {home,stage,jobs}=box();
  expect(stage([zzzbot,autonomy]).status).toBe(0);
  const failing=join(home,"bin","fail-hermes");
  writeFileSync(failing,"#!/usr/bin/env bash\nexit 1\n");chmodSync(failing,0o755);
  expect(stage([zzzbot,{...autonomy,skills:["unreviewed"]}],[],{HERMES_BIN:failing}).status).toBe(1);
  expect(JSON.parse(readFileSync(join(home,"mini-apps.json"),"utf8")).apps.map((app:{id:string})=>app.id))
    .toEqual(["zzzbot"]);
  // The job is inert (the projection gate is gone) but not forgotten: it stays a marker, and its files stay while it
  // remains, so no stage can call the box clean.
  expect(jobs().map(job=>job.name)).toEqual([AUTONOMY_JOB_NAME]);
  expect(autonomyMarkers(home)).toBe(true);
  expect(existsSync(join(home,"scripts",AUTONOMY_JOB_SCRIPT))).toBe(true);
  expect(stage([zzzbot],["--verify"]).status).toBe(1);
  // The next normal stage retries the removal and finishes the teardown.
  expect(stage([zzzbot]).status).toBe(0);
  expect(jobs()).toEqual([]);
  expect(existsSync(join(home,"scripts",AUTONOMY_JOB_SCRIPT))).toBe(false);
  expect(autonomyMarkers(home)).toBe(false);
  expect(stage([zzzbot],["--verify"]).status).toBe(0);
});

test("a job under the reserved name with a drifted prompt or toolsets is still torn down, or updated in place",()=>{
  const {home,stage,jobs}=box();
  expect(stage([zzzbot,autonomy]).status).toBe(0);
  const path=join(home,"cron/jobs.json");
  const drift=(change:Record<string,unknown>)=>{
    const doc=JSON.parse(readFileSync(path,"utf8"));
    doc.jobs=doc.jobs.map((job:Record<string,unknown>)=>job.name===AUTONOMY_JOB_NAME?{...job,...change}:job);
    writeFileSync(path,JSON.stringify(doc));
  };
  // An older release's prompt (or a resident edit) is updated in place, never a name conflict.
  drift({prompt:"an older prompt",enabled_toolsets:["web"]});
  expect(stage([zzzbot,autonomy]).status).toBe(0);
  expect(jobs().filter(job=>job.name===AUTONOMY_JOB_NAME)).toHaveLength(1);
  expect(stage([zzzbot,autonomy],["--verify"]).status).toBe(0);
  // Drifted again, then the gate is removed: the job still goes.
  drift({prompt:"an older prompt",enabled_toolsets:["web"]});
  expect(autonomyMarkers(home)).toBe(true);
  expect(stage([zzzbot]).status).toBe(0);
  expect(jobs()).toEqual([]);
  expect(stage([zzzbot],["--verify"]).status).toBe(0);
});

test("a dangling resident shim symlink never creates its outside target",()=>{
  const {home,stage}=box();
  mkdirSync(join(home,"scripts"));
  const target=join(home,"outside-target");
  symlinkSync(target,join(home,"scripts",AUTONOMY_JOB_SCRIPT));
  expect(stage([zzzbot,autonomy]).status).toBe(1);
  expect(existsSync(target)).toBe(false);
  expect(JSON.parse(readFileSync(join(home,"mini-apps.json"),"utf8")).apps.map((app:{id:string})=>app.id))
    .toEqual(["zzzbot"]);
});

test("a resident job that only mentions the reserved name is not a marker; the real job still is",()=>{
  const {home,stage,jobs}=box();
  mkdirSync(join(home,"cron"),{recursive:true});
  const resident=[
    {id:"bbbbbbbbbbbb",name:"Daily digest",prompt:`Summarise what ${AUTONOMY_JOB_NAME} posted today.`,enabled:true},
    {id:"cccccccccccc",name:`${AUTONOMY_JOB_NAME} (my notes)`,prompt:"notes",enabled:true},
  ];
  // The escaped spelling (—) too: the substring test over the raw store must not decide the marker.
  writeFileSync(join(home,"cron/jobs.json"),JSON.stringify({jobs:resident}).replaceAll("—","\\u2014"));
  expect(autonomyMarkers(home)).toBe(false);
  expect(stage([zzzbot]).status).toBe(0);
  expect(stage([zzzbot],["--verify"]).status).toBe(0);
  expect(stage([zzzbot],["--verify"]).status).toBe(0);
  expect(jobs()).toEqual(resident);
  // The real job (exact name) is a marker, installs beside the resident jobs, and its teardown leaves them alone.
  expect(stage([zzzbot,autonomy]).status).toBe(0);
  expect(autonomyMarkers(home)).toBe(true);
  expect(stage([zzzbot,autonomy],["--verify"]).status).toBe(0);
  expect(jobs().map(job=>job.name)).toEqual([...resident.map(job=>job.name),AUTONOMY_JOB_NAME]);
  expect(stage([zzzbot]).status).toBe(0);
  expect(jobs()).toEqual(resident);
  expect(autonomyMarkers(home)).toBe(false);
  expect(stage([zzzbot],["--verify"]).status).toBe(0);
});

test("teardown removes a FIFO (or any non-regular file) at the runner's state names",()=>{
  const {home,stage}=box();
  expect(stage([zzzbot,autonomy]).status).toBe(0);
  const state=join(home,"zzzbot");
  mkdirSync(state,{recursive:true,mode:0o700});
  const fifo=join(state,"autonomy-backoff.json"), lock=join(state,"autonomy-run.lock");
  expect(spawnSync("mkfifo",[fifo]).status).toBe(0);
  symlinkSync(join(home,"village-bridge.json"),lock);
  expect(stage([zzzbot]).status).toBe(0);
  for (const path of [fifo,lock]) expect(()=>lstatSync(path)).toThrow();
  // The symlink's target is untouched.
  expect(existsSync(join(home,"village-bridge.json"))).toBe(true);
  expect(stage([zzzbot],["--verify"]).status).toBe(0);
});
