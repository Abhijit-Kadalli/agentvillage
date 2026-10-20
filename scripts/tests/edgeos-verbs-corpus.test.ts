/**
 * EDGEOS-BLOCK step B (v2.1.10): every agent-facing command in skills/edgeos/SKILL.md, run through the REAL
 * approval.md hook (`approval hook hermes`) at the pinned core, on a fake box laid out as a real one, is
 * allowed from the Hermes folder.
 *
 * Why: the overlay installer sets the terminal's working directory to `$HERMES_HOME` (install/config.ts
 * setTerminalCwd, install/install.ts), which holds the box's `.env`. Core 0.4.6's credential pass
 * (src/cli/hook.ts refineCredentialReads) adds `account.credential` (human-only under the template) to a
 * reader whose words it cannot expand when the working directory holds credential material, so the v2.1.9
 * curl recipes (`-H "Authorization: Bearer $EDGEOS_API_KEY"`) were denied on every default box. The
 * skill's script runs carry no `$` word: the scripts read the key themselves.
 *
 * The box: a temp HOME with `.hermes/` (HERMES_HOME) holding `config.yaml`, a `.env` with dummy values
 * (`EDGEOS_API_KEY=example-not-a-key`; nothing real) and the skill's scripts at `skills/edgeos/scripts/`
 * (so the core's skill-script disk pass sees the real files); a separate approval store attested with the
 * overlay's own template policy (skills/approval/templates/APPROVAL.md, `<telegram_user_id>` = 1), as
 * review-b's organ-probe2.mjs does. Each command is sent as a Hermes `terminal` pre_tool_call with
 * `workdir` = HERMES_HOME (the box default; the assertion) and `workdir` = the home directory (recorded
 * only: the scripts' relative paths resolve from the Hermes folder alone, so the skill never sends them
 * from `~`). A positive control proves the probe sees the block: the v2.1.9 RSVP curl from HERMES_HOME
 * must be denied.
 *
 * It needs an approval-md checkout BUILT at the pinned version (`dist/src/cli/main.js`) named by
 * `AV_APPROVAL_MD_CORE_DIR`, and `node` on PATH. Overlay CI has neither, so it skips there; run it
 * locally:
 *
 *   AV_APPROVAL_MD_CORE_DIR=<approval-md checkout at v0.4.6, built> bun test scripts/tests/edgeos-verbs-corpus.test.ts
 *
 * No network: the hook only classifies; nothing it allows is run.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The core pin, read from fetch-url-shape.test.ts (importing that file would run its tests here too). */
const APPROVAL_MD_PINNED = (readFileSync(join(import.meta.dir, "fetch-url-shape.test.ts"), "utf8")
  .match(/export const APPROVAL_MD_PINNED = "([^"]+)"/) ?? [])[1];

const REPO = join(import.meta.dir, "..", "..");
const SKILL = join(REPO, "skills", "edgeos", "SKILL.md");
const CORE = process.env.AV_APPROVAL_MD_CORE_DIR ?? "";
const CLI = CORE ? join(CORE, "dist", "src", "cli", "main.js") : "";
const NODE = spawnSync("node", ["--version"], { encoding: "utf8" }).status === 0;
const HAVE_CORE = CORE !== "" && existsSync(CLI) && NODE;

const FILL: [RegExp, string][] = [
  [/\{(current_iso_timestamp|start_iso|occurrence_iso)\}/g, "2026-10-21T10:00:00Z"],
  [/\{end_iso\}/g, "2026-10-22T10:00:00Z"],
  [/\{(event_id|popup_id)\}/g, "3fa85f64-5717-4562-b3fc-2c963f66afa6"],
];

/**
 * Every agent-facing command in the skill: each line of every fenced shell block (continuations joined),
 * placeholders filled, plus any inline `curl`/`wget`/`bun` span (there are none to run, but one added
 * later is probed too).
 */
export function skillCommands(text = readFileSync(SKILL, "utf8")): { where: string; command: string }[] {
  const out: { where: string; command: string }[] = [];
  const lines = text.split("\n");
  let fence: string | null = null;
  let pending = "";
  lines.forEach((line, i) => {
    const open = line.match(/^\s*(`{3,})\s*([A-Za-z0-9_-]*)/);
    if (fence === null && open) {
      fence = ["", "sh", "bash", "shell", "zsh", "console"].includes(open[2].toLowerCase()) ? open[1] : "skip";
      return;
    }
    if (fence !== null && line.trim().startsWith("```")) {
      fence = null;
      return;
    }
    if (fence === "skip") return;
    if (fence !== null) {
      pending += (pending ? " " : "") + line.replace(/\\\s*$/, "");
      if (/\\\s*$/.test(line)) return;
      const command = pending.trim();
      pending = "";
      if (command && !command.startsWith("#")) out.push({ where: `SKILL.md:${i + 1}`, command });
      return;
    }
    for (const m of line.matchAll(/`([^`\n]+)`/g)) {
      if (/^\s*(curl|wget|bun)\s/.test(m[1]) && !/[…<]/.test(m[1])) out.push({ where: `SKILL.md:${i + 1}`, command: m[1] });
    }
  });
  return out.map(({ where, command }) => {
    for (const [re, v] of FILL) command = command.replace(re, v);
    return { where, command };
  });
}

/** The v2.1.9 RSVP recipe (continuations joined): the positive control. */
const LEGACY_RSVP =
  'curl -s -X POST -H "Authorization: Bearer $EDGEOS_API_KEY" -H "Content-Type: application/json" ' +
  '--url "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/event-participants/portal/register/3fa85f64-5717-4562-b3fc-2c963f66afa6" -d \'{}\'';

interface Box {
  home: string;
  hermes: string;
  store: string;
  env: NodeJS.ProcessEnv;
}

function box(): Box {
  const base = mkdtempSync(join(tmpdir(), "edgeos-verbs-corpus-"));
  const home = join(base, "home");
  const hermes = join(home, ".hermes");
  const store = join(base, "store");
  mkdirSync(join(hermes, "skills", "edgeos"), { recursive: true });
  mkdirSync(store, { recursive: true });
  writeFileSync(join(hermes, "config.yaml"), "terminal:\n  cwd: " + hermes + "\n");
  writeFileSync(
    join(hermes, ".env"),
    "EDGEOS_API_KEY=example-not-a-key\nAV_POPUP_ID=3fa85f64-5717-4562-b3fc-2c963f66afa6\nCONTROL_PLANE_URL=https://cp.example.test\nTENANT_ID=00000000-0000-4000-8000-000000000000\n",
  );
  cpSync(join(REPO, "skills", "edgeos", "scripts"), join(hermes, "skills", "edgeos", "scripts"), { recursive: true });
  cpSync(SKILL, join(hermes, "skills", "edgeos", "SKILL.md"));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, HERMES_HOME: hermes };
  delete env.APPROVAL_HUMAN;
  delete env.APPROVAL_HERMES_HOME;
  const cli = (args: string[], input = "") =>
    spawnSync("node", [CLI, ...args], { cwd: store, env, input, encoding: "utf8", timeout: 120_000 });
  const init = cli(["init", "--json"]);
  if (init.status !== 0) throw new Error(`approval init failed: ${init.stderr}`);
  const policy = readFileSync(join(REPO, "skills", "approval", "templates", "APPROVAL.md"), "utf8").replaceAll("<telegram_user_id>", "1");
  writeFileSync(join(store, "APPROVAL.md"), policy);
  const attest = cli(["policy", "attest", "--bootstrap", "--as", "human:operator"]);
  if (attest.status !== 0) throw new Error(`approval policy attest failed: ${attest.stderr}`);
  return { home, hermes, store, env };
}

interface Verdict {
  exit: number | null;
  out: string;
}

let n = 0;
function hook(b: Box, command: string, workdir: string): Verdict {
  n += 1;
  const id = `edgeos-verbs-${n}`;
  const input = JSON.stringify({
    hook_event_name: "pre_tool_call", session_id: "edgeos-verbs", tool_use_id: id, cwd: b.store, profile: "default",
    tool_name: "terminal", tool_input: { command, workdir }, extra: { turn_id: "t", tool_call_id: id },
  });
  const r = spawnSync("node", [CLI, "hook", "hermes", "--as", "agent:hermes", "--harness-cap", "300s", "--timeout", "200ms"], {
    cwd: b.store, env: b.env, input, encoding: "utf8", timeout: 120_000,
  });
  return { exit: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

const denied = (v: Verdict) => v.exit !== 0 || /account\.credential|human-only|"block"|deny/i.test(v.out);

describe.skipIf(!HAVE_CORE)("the real approval hook allows every edgeos skill command from the Hermes folder (AV_APPROVAL_MD_CORE_DIR)", () => {
  test("the core checkout is the pinned version", () => {
    expect(JSON.parse(readFileSync(join(CORE, "package.json"), "utf8")).version).toBe(APPROVAL_MD_PINNED);
  });

  test("every command: allowed with workdir = HERMES_HOME; the v2.1.9 curl is denied there (control)", () => {
    const b = box();
    const commands = skillCommands();
    expect(commands.length).toBeGreaterThanOrEqual(11 + 4 + 2 + 3);
    const rows: string[] = [];
    const held: string[] = [];
    for (const { where, command } of commands) {
      const atHermes = hook(b, command, b.hermes);
      const atHome = hook(b, command, b.home);
      rows.push(`${where}\thh=${atHermes.exit}\thome=${atHome.exit}\t${command}`);
      if (denied(atHermes)) held.push(`${where} ${command} -> exit ${atHermes.exit} ${atHermes.out.slice(0, 300)}`);
    }
    const control = hook(b, LEGACY_RSVP, b.hermes);
    rows.push(`control\thh=${control.exit}\t-\t${LEGACY_RSVP}`);
    if (process.env.EDGEOS_CORPUS_PRINT) console.log(rows.join("\n"));
    expect(held).toEqual([]);
    expect(control.exit).not.toBe(0);
    expect(control.out).toContain("account.credential");
  }, 600_000);
});
