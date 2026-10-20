/**
 * The suggestion rating cards, the trigger's half (rating-cards.ts through proactive.ts's evening
 * action; data docs/design/suggestion-rating.md). The plugin's half (sending, taps, the ledger,
 * the hand-off) is plugins/av-rate/tests.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BriefOpportunity } from "../build-daily-brief-context";
import { type ProactiveOptions, runProactive } from "../proactive";
import {
  CARDS_PER_EVENING,
  STALE_DAYS,
  dueRatingSubjects,
  noteAccepted,
  ratedLedgerPath,
  ratingStageDir,
  ratingStageFor,
  readRatedIds,
  recordStaged,
  stageTest,
} from "../rating-cards";

/** 19:00 IST on 2026-10-21. */
const EVENING = new Date("2026-10-21T13:30:00Z");
const DATE = "2026-10-21";
const OPP = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const OPP2 = "1b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const OPP3 = "2b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const OPP4 = "3b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const THIRD_PARTY = "THIRD PARTY WORDS";

let home: string;
const ENV = ["AV_RATE_CARDS", "AV_OUTCOME_TEXT_ASK", "AV_EVENTS_TOKEN", "AV_HOOKS_DISABLED", "AV_EVENTS_ENABLED"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "av-rating-cards-"));
  mkdirSync(join(home, "memory"), { recursive: true });
  savedEnv = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
  process.env.AV_RATE_CARDS = "1";
  delete process.env.AV_OUTCOME_TEXT_ASK;
  process.env.AV_EVENTS_TOKEN = "test-token";
  delete process.env.AV_HOOKS_DISABLED;
  delete process.env.AV_EVENTS_ENABLED;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const name of ENV) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

const stateFile = () => join(home, "memory", "heartbeat-state.json");
const state = (): Record<string, any> => (existsSync(stateFile()) ? JSON.parse(readFileSync(stateFile(), "utf8")) : {});
const writeState = (value: Record<string, unknown>) => writeFileSync(stateFile(), JSON.stringify(value));

function accepted(name: string, id = OPP, over: Partial<BriefOpportunity> = {}): BriefOpportunity {
  return { name, opportunityId: id, status: "accepted", headline: `${THIRD_PARTY} headline`, mainText: `${THIRD_PARTY} summary`, userUrl: `https://index.network/u/${id}`, opportunityUrl: `https://index.network/o/${id}`, ...over };
}

const REMINDER = { name: "Pending Person", headline: THIRD_PARTY, userUrl: "https://index.network/u/p", opportunityUrl: "https://index.network/o/p" };

function options(over: Partial<ProactiveOptions> = {}): ProactiveOptions {
  return { home, now: () => EVENING, lock: { waitMs: 50, pollMs: 5 }, accepted: async () => [accepted("Arjun Mehta")], evening: async () => REMINDER, ...over };
}

function stages(): Array<Record<string, any>> {
  const dir = ratingStageDir(home);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")));
}

function runLog(): Array<Record<string, any>> {
  const path = join(home, "av-events", "proactive", "triggers.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
}

/** As the plugin writes it: 0600 in a private directory. */
function markRated(...ids: string[]): void {
  mkdirSync(join(home, "av-events", "proactive"), { recursive: true, mode: 0o700 });
  writeFileSync(ratedLedgerPath(home), JSON.stringify({ v: 1, cards: Object.fromEntries(ids.map((id) => [id, { nonce: "n".repeat(22) }])) }), { mode: 0o600 });
  chmodSync(ratedLedgerPath(home), 0o600);
}

describe("the evening run stages a card pair for every newly accepted connection", () => {
  test("one accepted connection: a 0600 stage with the cleaned name, no headline when Index gave none, and the reminder still goes out", async () => {
    const result = await runProactive("evening", options());
    expect(result.woke).toBe(true);
    const out = JSON.parse(result.lines.slice(0, -1).join("\n"));
    expect(out.person.name).toBe("Pending Person");
    expect(out.outcomeQuestion).toBeUndefined();
    const [stage] = stages();
    expect(stage).toEqual({ v: 1, opportunity_id: OPP, intention_id: null, name: "Arjun Mehta", headline: null, agent_name: "Edge", staged_at: EVENING.toISOString(), date: DATE });
    const dir = ratingStageDir(home);
    expect(statSync(join(dir, readdirSync(dir)[0])).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(state().ratingCards).toEqual({ firstSeen: { [OPP]: DATE }, staged: { [OPP]: DATE } });
    expect(runLog().at(-1)).toMatchObject({ action: "evening", decision: "woke", detail: "outcome-ask-text-off_rating-cards:1" });
  });

  test("Index's own headline rides along when it cleans; the summary never does", async () => {
    await runProactive("evening", options({ accepted: async () => [accepted("Maya Rao", OPP, { matchHeadline: "Climate finance" })] }));
    expect(stages()[0].headline).toBe("Climate finance");
    expect(JSON.stringify(stages())).not.toContain(THIRD_PARTY);
  });

  test("a name that does not clean is passed over and counted; the others are staged", async () => {
    await runProactive("evening", options({ accepted: async () => [accepted("www evil", OPP), accepted("Maya Rao", OPP2)] }));
    expect(stages().map((s) => s.opportunity_id)).toEqual([OPP2]);
    expect(runLog().at(-1).detail).toBe("outcome-ask-text-off_rating-cards:1:withheld:1");
  });

  test("at most CARDS_PER_EVENING tonight, oldest first seen first; the rest roll to the next evening", async () => {
    writeState({ ratingCards: { firstSeen: { [OPP4]: "2026-10-20" }, staged: {} } });
    const all = [accepted("A One", OPP), accepted("B Two", OPP2), accepted("C Three", OPP3), accepted("D Four", OPP4)];
    await runProactive("evening", options({ accepted: async () => all }));
    expect(CARDS_PER_EVENING).toBe(3);
    expect(stages().map((s) => s.opportunity_id).sort()).toEqual([OPP, OPP2, OPP4].sort());
    expect(state().ratingCards.staged).toEqual({ [OPP4]: DATE, [OPP]: DATE, [OPP2]: DATE });
    // The next evening: OPP3 is due (first seen tonight), the staged three are not asked yet and not staged today, so due again too.
    const next = dueRatingSubjects(state(), all.map((c) => c.opportunityId!), new Set(), "2026-10-22");
    expect(next).toEqual([OPP4, OPP, OPP2]);
    // Once the plugin records the three, only OPP3 is due.
    expect(dueRatingSubjects(state(), all.map((c) => c.opportunityId!), new Set([OPP, OPP2, OPP4]), "2026-10-22")).toEqual([OPP3]);
  });

  test("a subject the plugin recorded as asked is never staged again", async () => {
    markRated(OPP);
    await runProactive("evening", options());
    expect(stages()).toEqual([]);
    expect(state().ratingCards).toEqual({ firstSeen: {}, staged: {} });
    expect(runLog().at(-1).detail).toBe("outcome-ask-text-off_rating-cards:0");
  });

  test("an acceptance first seen more than STALE_DAYS ago and still unasked is dropped from due", () => {
    const seen = { ratingCards: { firstSeen: { [OPP]: "2026-10-17", [OPP2]: "2026-10-18" }, staged: {} } };
    expect(STALE_DAYS).toBe(3);
    expect(dueRatingSubjects(seen, [OPP, OPP2], new Set(), DATE)).toEqual([OPP2]);
  });

  test("the cards off: nothing staged, no state, and the run log says nothing about cards", async () => {
    delete process.env.AV_RATE_CARDS;
    await runProactive("evening", options());
    expect(stages()).toEqual([]);
    expect(state().ratingCards).toBeUndefined();
    expect(runLog().at(-1).detail).toBe("outcome-ask-text-off");
  });

  test("Index down: nothing staged, a code in the run log, and the reminder still goes out", async () => {
    const result = await runProactive("evening", options({ accepted: async () => { throw new Error("down"); } }));
    expect(result.woke).toBe(true);
    expect(stages()).toEqual([]);
    expect(runLog().at(-1).detail).toBe("outcome-ask-text-off_rating-cards-index-unavailable");
  });

  test("a ledger the plugin would refuse means nothing staged tonight", async () => {
    markRated(OPP2);
    chmodSync(ratedLedgerPath(home), 0o644);
    await runProactive("evening", options());
    expect(stages()).toEqual([]);
    expect(runLog().at(-1).detail).toBe("outcome-ask-text-off_rating-cards-ledger-unreadable");
    expect(readRatedIds(home)).toBeNull();
  });

  test("the template evening job and a done day stage nothing", async () => {
    writeState({ proactiveRuns: { evening: DATE } });
    const result = await runProactive("evening", options());
    expect(result.reason).toBe("done-today");
    expect(stages()).toEqual([]);
  });

  test("the old text ask runs only with AV_OUTCOME_TEXT_ASK on", async () => {
    process.env.AV_OUTCOME_TEXT_ASK = "1";
    writeState({ negotiationSummary: { reportedCompletedIds: [OPP], announcedOn: { [OPP]: "2026-10-19" } } });
    const result = await runProactive("evening", options());
    const out = JSON.parse(result.lines.slice(0, -1).join("\n"));
    expect(out.outcomeQuestion).toBe("Did you and Arjun Mehta meet? Reply met, not useful, or missed.");
    expect(runLog().at(-1).detail).toBe("outcome-ask_rating-cards:1");
  });
});

describe("the helpers", () => {
  test("readRatedIds: none, some, unreadable", () => {
    expect(readRatedIds(home)).toEqual(new Set());
    markRated(OPP, OPP2);
    expect(readRatedIds(home)).toEqual(new Set([OPP, OPP2]));
    writeFileSync(ratedLedgerPath(home), "{not json");
    expect(readRatedIds(home)).toBeNull();
  });

  test("noteAccepted dates the new ones today, keeps the old dates, drops the asked", () => {
    const first = noteAccepted({}, [OPP, OPP2], new Set(), "2026-10-20");
    expect(first.ratingCards).toEqual({ firstSeen: { [OPP]: "2026-10-20", [OPP2]: "2026-10-20" }, staged: {} });
    const second = noteAccepted(recordStaged(first, [OPP], "2026-10-20"), [OPP2, OPP3], new Set([OPP]), DATE);
    expect(second.ratingCards).toEqual({ firstSeen: { [OPP2]: "2026-10-20", [OPP3]: DATE }, staged: {} });
  });

  test("ratingStageFor: bounds, one matched intent only, never a guess", () => {
    const cleaned = { name: " Maya ", headline: "x".repeat(200), agentName: "A".repeat(50) };
    const stage = ratingStageFor({ opportunityId: OPP, matchedIntentIds: ["intent-1"] }, cleaned, DATE, EVENING)!;
    expect(stage.name).toBe("Maya");
    expect(stage.headline!.length).toBe(120);
    expect(stage.agent_name.length).toBe(40);
    expect(stage.intention_id).toBe("intent-1");
    expect(ratingStageFor({ opportunityId: OPP, matchedIntentIds: ["a", "b"] }, cleaned, DATE, EVENING)!.intention_id).toBeNull();
    expect(ratingStageFor({ opportunityId: "has space" }, cleaned, DATE, EVENING)).toBeNull();
    expect(ratingStageFor({ opportunityId: OPP }, { ...cleaned, name: "  " }, DATE, EVENING)).toBeNull();
  });

  test("--stage-test writes one stage by hand, no Index call, no state", () => {
    const lines = stageTest(["--stage-test", "--opportunity", OPP, "--name", "Maya", "--headline", "Climate finance"], home, EVENING);
    expect(lines[0]).toContain("wrote");
    expect(stages()).toEqual([{ v: 1, opportunity_id: OPP, intention_id: null, name: "Maya", headline: "Climate finance", agent_name: "Edge", staged_at: EVENING.toISOString(), date: DATE }]);
    expect(existsSync(stateFile())).toBe(false);
    expect(stageTest(["--stage-test"], home, EVENING)[0]).toContain("required");
  });
});
