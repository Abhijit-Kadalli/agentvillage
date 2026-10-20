/**
 * The suggestion rating cards: the trigger's half (data docs/design/suggestion-rating.md).
 *
 * On the evening run, every connection Index lists as `accepted` that the av-rate plugin has not
 * asked about yet is staged for a card pair (card 1: how good a match the suggestion was, five
 * buttons; card 2: whether the meetup was already planned), the same evening it is first seen
 * accepted (the old outcome ask waited two days), oldest first, at most CARDS_PER_EVENING per
 * evening. The rest roll to the next evening; one first seen more than STALE_DAYS village days ago
 * and still unasked is dropped from due.
 *
 * The trigger writes ONE stage file per subject into `av-events/proactive/rating/` (0600 in a 0700
 * folder, by temp file and rename): `{v, opportunity_id, intention_id, name, headline, agent_name,
 * staged_at, date}`. The cleaned name and headline are the only text and they never reach an
 * event: `plugins/av-rate` reads the file, sends the card, records the subject on its ledger
 * `av-events/proactive/rated.json`, and the trigger reads that ledger as "asked". Nothing the model
 * says is involved: the evening job's model turn sends its reminder or closeout as before.
 *
 * State (`heartbeat-state.json` `ratingCards`): `firstSeen` = opportunity id -> the village date it
 * was first listed accepted by an evening run (the staleness and ordering clock); `staged` =
 * opportunity id -> the date it was last staged (never twice on one date).
 *
 * The cap counts card pairs only: the trigger keeps no count of the day's other proactive
 * deliveries (each job has a day mark, not a budget), so the agreed 3/day ceiling is applied to
 * the cards alone here and read fleet-wide on the data side.
 *
 * `--stage-test`: writes one stage file by hand, no Index call, for a developer testing the plugin
 * with their own bot (plugins/av-rate/README.md "Local test with your own bot").
 */

import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { BriefOpportunity } from "./build-daily-brief-context";
import { villageDate } from "./build-daily-brief-context";
import { envOrDotenv } from "./proactive-text";

/** The on-switch, read like every other AV_* variable: the environment, else `$HERMES_HOME/.env`. */
export const CARDS_SWITCH = "AV_RATE_CARDS";
/** The old text ask's switch (default off): proactive.ts `outcomeAskDecision` runs only with it on. */
export const TEXT_ASK_SWITCH = "AV_OUTCOME_TEXT_ASK";
const TRUTHY = new Set(["1", "true", "yes", "on"]);
/** Card pairs staged per evening at most (the agreed proactive ceiling, applied to the cards alone). */
export const CARDS_PER_EVENING = 3;
/** An acceptance first seen more than this many village days ago and still unasked is no longer due. */
export const STALE_DAYS = 3;
export const RATING_STATE_KEY = "ratingCards";
export const STAGE_VERSION = 1;
export const QUESTION_VERSION = "match_fit_5_v1";
const NAME_MAX = 80;
const HEADLINE_MAX = 120;
const AGENT_NAME_MAX = 40;
/** An envelope id (agentvillage-data src/envelope.ts ID_PATTERN; the plugin's ID_PATTERN). */
const ENVELOPE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** The plugin's size cap for its ledger (av-rate LEDGER_MAX_BYTES). */
const LEDGER_MAX_BYTES = 512 * 1024;

export function ratingCardsOn(home: string): boolean {
  return TRUTHY.has(envOrDotenv(CARDS_SWITCH, home).toLowerCase());
}

export function textAskOn(home: string): boolean {
  return TRUTHY.has(envOrDotenv(TEXT_ASK_SWITCH, home).toLowerCase());
}

export function ratingStageDir(home: string): string {
  return join(home, "av-events", "proactive", "rating");
}

/** Written by the plugin only; the trigger reads it. */
export function ratedLedgerPath(home: string): string {
  return join(home, "av-events", "proactive", "rated.json");
}

export interface RatingStage {
  v: typeof STAGE_VERSION;
  opportunity_id: string;
  intention_id: string | null;
  name: string;
  headline: string | null;
  agent_name: string;
  staged_at: string;
  date: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function dayNumber(date: string): number | null {
  if (!DATE.test(date)) return null;
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(ms) ? null : Math.round(ms / 86_400_000);
}

/**
 * Opportunity ids the plugin recorded as asked (its ledger's `cards` keys): empty when there is no
 * ledger yet, null when one exists but cannot be trusted (not a private regular file of this user
 * in a private folder, too big, not the shape). Null means "stage nothing tonight": the plugin never
 * writes over a ledger it refuses, so it could record nothing new and a card would go out again.
 */
export function readRatedIds(home: string): Set<string> | null {
  const path = ratedLedgerPath(home);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  try {
    let file;
    try {
      file = lstatSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Set();
      return null;
    }
    const dir = lstatSync(dirname(path));
    if (!dir.isDirectory() || (uid !== null && dir.uid !== uid) || dir.mode & 0o022) return null;
    if (!file.isFile() || (uid !== null && file.uid !== uid) || file.mode & 0o077 || file.size > LEDGER_MAX_BYTES) return null;
    const data = JSON.parse(readFileSync(path, "utf8"));
    const cards = data && typeof data === "object" && !Array.isArray(data) && data.v === 1 ? data.cards : undefined;
    if (!cards || typeof cards !== "object" || Array.isArray(cards)) return null;
    return new Set(Object.keys(cards));
  } catch {
    return null;
  }
}

/** `ratingCards.firstSeen` and `.staged`, valid entries only. */
export function ratingState(state: Record<string, unknown>): { firstSeen: Record<string, string>; staged: Record<string, string> } {
  const raw = asRecord(state[RATING_STATE_KEY]);
  const dates = (value: unknown) => Object.fromEntries(Object.entries(asRecord(value)).filter((e): e is [string, string] => typeof e[1] === "string" && DATE.test(e[1])));
  return { firstSeen: dates(raw.firstSeen), staged: dates(raw.staged) };
}

/**
 * The state with every listed accepted id first seen (`date` for the new ones), and entries for
 * ids the plugin has asked about dropped. Pure.
 */
export function noteAccepted(state: Record<string, unknown>, acceptedIds: readonly string[], asked: Set<string>, date: string): Record<string, unknown> {
  const current = ratingState(state);
  const firstSeen: Record<string, string> = {};
  for (const [id, on] of Object.entries(current.firstSeen)) if (!asked.has(id)) firstSeen[id] = on;
  for (const id of acceptedIds) if (!asked.has(id) && !(id in firstSeen) && ENVELOPE_ID.test(id)) firstSeen[id] = date;
  const staged: Record<string, string> = {};
  for (const [id, on] of Object.entries(current.staged)) if (!asked.has(id) && id in firstSeen) staged[id] = on;
  return { ...state, [RATING_STATE_KEY]: { ...asRecord(state[RATING_STATE_KEY]), firstSeen, staged } };
}

/**
 * Opportunity ids due a card pair on `date`, oldest first seen first, then by id, at most
 * CARDS_PER_EVENING: listed accepted now, not asked, not staged today, first seen within
 * STALE_DAYS. The state must already carry tonight's `noteAccepted`.
 */
export function dueRatingSubjects(state: Record<string, unknown>, acceptedIds: readonly string[], asked: Set<string>, date: string): string[] {
  const today = dayNumber(date);
  if (today === null) return [];
  const { firstSeen, staged } = ratingState(state);
  const listed = new Set(acceptedIds);
  return Object.entries(firstSeen)
    .flatMap(([id, on]) => {
      const day = dayNumber(on);
      if (day === null || !listed.has(id) || asked.has(id) || staged[id] === date) return [];
      if (today - day > STALE_DAYS) return [];
      return [[id, on] as const];
    })
    .sort((a, b) => (a[1] === b[1] ? (a[0] < b[0] ? -1 : 1) : a[1] < b[1] ? -1 : 1))
    .map(([id]) => id)
    .slice(0, CARDS_PER_EVENING);
}

/** The state with `ids` recorded as staged on `date`. */
export function recordStaged(state: Record<string, unknown>, ids: readonly string[], date: string): Record<string, unknown> {
  const current = ratingState(state);
  const staged = { ...current.staged };
  for (const id of ids) staged[id] = date;
  return { ...state, [RATING_STATE_KEY]: { ...asRecord(state[RATING_STATE_KEY]), firstSeen: current.firstSeen, staged } };
}

/**
 * The stage for one subject. `name`, `headline` and `agentName` are already cleaned (proactive.ts
 * Withheld / agentNameFor): this only bounds them. Null when the id cannot be an envelope id.
 */
export function ratingStageFor(
  card: Pick<BriefOpportunity, "opportunityId" | "matchedIntentIds">,
  cleaned: { name: string; headline: string | null; agentName: string },
  date: string,
  now: Date,
): RatingStage | null {
  const id = card.opportunityId;
  if (!id || !ENVELOPE_ID.test(id)) return null;
  const intentIds = Array.isArray(card.matchedIntentIds) ? Array.from(new Set(card.matchedIntentIds)) : [];
  const intention = intentIds.length === 1 && typeof intentIds[0] === "string" && ENVELOPE_ID.test(intentIds[0]) ? intentIds[0] : null;
  const name = cleaned.name.trim().slice(0, NAME_MAX);
  if (!name) return null;
  const headline = cleaned.headline ? cleaned.headline.slice(0, HEADLINE_MAX) : null;
  return {
    v: STAGE_VERSION,
    opportunity_id: id,
    intention_id: intention,
    name,
    headline: headline || null,
    agent_name: cleaned.agentName.slice(0, AGENT_NAME_MAX) || "Edge",
    staged_at: now.toISOString(),
    date,
  };
}

export function ratingStagePath(home: string, opportunityId: string): string {
  return join(ratingStageDir(home), `stage-${opportunityId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

/** Write the stage by temp file and rename (0600, its directory 0700). Throws on failure. */
export function writeRatingStage(home: string, stage: RatingStage): string {
  const path = ratingStagePath(home, stage.opportunity_id);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(stage)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return path;
}

function argValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

/**
 * `--stage-test --opportunity <id> [--name Maya] [--headline "..."] [--agent Edge]`: one stage file,
 * no Index call, no state change. For a developer's own bot. Returns the lines to print.
 */
export function stageTest(args: string[], home: string, now = new Date()): string[] {
  const id = argValue(args, "--opportunity");
  if (!id || !ENVELOPE_ID.test(id)) return ["stage-test: --opportunity <id> is required (letters, digits, . _ : -)"];
  const stage = ratingStageFor(
    { opportunityId: id },
    { name: argValue(args, "--name") ?? "Maya", headline: argValue(args, "--headline") ?? null, agentName: argValue(args, "--agent") ?? "Edge" },
    villageDate(now),
    now,
  );
  if (!stage) return ["stage-test: nothing staged"];
  const path = writeRatingStage(home, stage);
  return [`stage-test: wrote ${path}`, "stage-test: the av-rate plugin sends the card within about a minute when AV_RATE_CARDS is on"];
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--stage-test")) {
    const home = process.env.HERMES_HOME?.trim() || process.cwd();
    for (const line of stageTest(args, home)) console.log(line);
  } else {
    console.log("usage: bun skills/index-network/scripts/rating-cards.ts --stage-test --opportunity <id> [--name <name>] [--headline <text>] [--agent <name>]");
  }
}
