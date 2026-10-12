/**
 * SEED-REVISION (ov#302 combined round): the guard on Index's recovery
 * question before the AGENTS.md welcome gate's REFUSED_SEEDS block hands it to
 * the agent's first chat turn (welcome.ts refusedQuestion).
 *
 * It FAILS CLOSED (commit review of d738cf87): the question is optional and
 * its null path costs nothing (the agent asks the fixed "What would make it
 * clearer?"), so any doubt withholds it. A real Index recovery question is one
 * plain question about the resident's own intent (who, what outcome, by
 * when); it never names a destination. questionGuardHit returns the first
 * reason, in this order:
 *
 *   - `hidden`: a control, format, zero-width, bidi, private-use or
 *     default-ignorable character, or a line break;
 *   - `confusable`: a word mixing scripts (`іgnore`);
 *   - `scanner`: Hermes's cron scanner phrase in any check reading
 *     (questionReadings), also with every space and joiner removed;
 *   - `tool_name`: a snake_case word, or TOOL_NAMES in any reading and
 *     spelling (snake, camel, hyphen, spaced, joined, upper case); a spaced
 *     or camel form matches only where the name has a part boundary ("to do"
 *     is not `todo`);
 *   - `destination`: a link or address shape (`://`, `www`, a dotted host,
 *     "dot com", `@`, t.me / wa.me), an email, a phone-like digit run, a
 *     wallet-like token, a currency sign or word, or a word that asks to
 *     contact, pay, click, visit, download, install or enter a code or OTP;
 *   - `stop_word`: STOP_WORD in any reading, also two or more adjacent
 *     words read as one (`i g n o r e`, `sen d`);
 *   - `mixed_word`: a word mixing letters and digits (`1gnore`, `0x52…`);
 *   - `shape`: any character but letters, marks, digits, spaces and
 *     `, ' ’ - ( ) &` before one final `?` (no emoji, quotes, dots, colons,
 *     slashes, symbols);
 *   - `not_question`: no final `?`, more than one, or a first word that is
 *     not a question word (QUESTION_START: no imperative start);
 *   - `quotes_line`: the resident's own line quoted back inside it;
 *   - `too_long`: over QUESTION_MAX code points (withheld, never cut).
 *
 * Pure; never throws; nothing of the text is returned or logged.
 */

import { cronScanHit } from "./proactive-text";

/** Code points a recovery question may have; a longer one is withheld whole. */
export const QUESTION_MAX = 160;

/**
 * The tool names the guard reads, hyphen-joined (index-tool-names.test.ts
 * reads this folder for snake_case tool names; the guard folds every spelling
 * alike): the av-events plugin's (plugins/av-events/tool_categories.json
 * `builtin` and `mcp.index`; edgeos_tool_allowlist.json `carrier_tools`),
 * the Index tools welcome.ts calls (index-mcp.ts callIndexTool), and
 * welcome.ts's own output markers. Kept here, not read at run time, so the
 * guard never depends on a plugin file on the box; welcome-seed.test.ts fails
 * when either file names a tool this list misses.
 */
export const TOOL_NAMES: readonly string[] = `
  accept-opportunity add-contact archive-intent browser-back browser-cdp browser-click browser-console browser-dialog browser-exec
  browser-get-images browser-navigate browser-press browser-scroll browser-snapshot browser-type browser-vision cancel-discovery-run
  cancel-enrichment-run clarify complete-onboarding confirm-opportunity-delivery confirm-user-context consent-status create-intent
  create-intent-index create-network create-network-membership create-premise create-user-context cronjob delegate-task delete-agent
  delete-intent delete-intent-index delete-network delete-network-membership discover-opportunities enrich-my-profile execute-code
  get-conversation get-discovery-run get-enrichment-run get-intent get-my-profile get-negotiation get-opportunity grant-agent-permission
  image-generate import-contacts import-gmail-contacts index-add-intent-to-network index-agent-me index-create-intent index-create-network
  index-join-network index-list-intent-networks index-list-opportunities index-read-docs index-read-intents index-read-network-memberships
  index-read-networks index-research-profile index-update-intent index-update-network index-update-opportunity list-agents list-contacts
  list-conversations list-intents list-negotiations list-opportunities memory opportunity-outcome patch pause-intent preview-user-context
  process read-docs read-file read-intent-indexes read-intents read-network-memberships read-networks read-pending-questions read-premises
  read-user-contexts recall record-intention record-onboarding-privacy-consent register-agent reject-opportunity remove-contact resume-intent
  retract-premise revoke-agent-permission scrape-url search-contacts search-files search-intents send-message session-search skill-manage
  skill-view skills-list terminal text-to-speech todo update-agent update-intent update-my-profile update-network update-opportunity
  update-premise update-user-context video-analyze vision-analyze web-extract web-search write-file x-search
  welcome-already-sent refused-seeds
`
  .trim()
  .split(/\s+/);

export type GuardHit =
  | "hidden"
  | "confusable"
  | "scanner"
  | "tool_name"
  | "destination"
  | "stop_word"
  | "mixed_word"
  | "shape"
  | "not_question"
  | "quotes_line"
  | "too_long";

/** The words that withhold a question, whole words in any reading, with their inflections (the lead's list). */
const STOP_WORD =
  /^(?:ignor(?:e|es|ed|ing)|instructions?|systems?|prompts?|overrid(?:e|es|ing|den)|overrode|tools?|call(?:s|ed|ing)?|publish(?:es|ed|ing)?|approv(?:e|es|ed|ing|al)|passwords?|wallets?|telegram|send(?:s|ing)?|sent|forward(?:s|ed|ing)?|delet(?:e|es|ed|ing|ion)|seedphrases?|share[sd]?|sharing|rules?)$/;
/** Base forms two or more adjacent words may not join into (`i g n o r e`). */
const JOINED_STOPS = ["ignore", "instructions", "system", "prompt", "override", "tool", "call", "publish", "approve", "password", "wallet", "telegram", "send", "forward", "delete", "seedphrase", "share", "contact", "click", "visit", "download", "install", "enter", "otp"];
const JOINED_STOP_MAX = Math.max(...JOINED_STOPS.map((s) => s.length));

/** Words that ask to go somewhere, reach someone, pay, or enter a code (review flag 1). */
const DESTINATION_WORD =
  /^(?:https?|www|url|urls|links?|website|websites|site|sites|domains?|e?mails?|emailed|gmail|inbox|dms?|whatsapp|discord|slack|instagram|insta|linkedin|twitter|phones?|sms|otps?|passcodes?|pins?|verification|verify|tme|wame|contact(?:s|ed|ing)?|pay(?:s|ing|ment|ments)?|paid|fees?|deposits?|transfer(?:s|red)?|refunds?|money|rupees?|rs|inr|usd|usdt|usdc|dollars?|eur|euros?|crypto|bitcoin|btc|eth|ether|tokens?|address(?:es)?|click(?:s|ed|ing)?|visit(?:s|ed|ing)?|download(?:s|ed|ing)?|install(?:s|ed|ing)?|enter(?:s|ed|ing)?)$/;
const TLD = "(?:com|org|net|io|in|me|co|xyz|app|dev|ai|gg|ly|link|site|info|biz|online|club|live|tech|so|sh)";
/** Raw shapes of a destination (on the NFKC text, case-insensitive). */
const DESTINATION_SHAPES: readonly RegExp[] = [
  /:\/\//u,
  /\bwww\b/iu,
  /[\p{L}\p{N}-]\s*[.\u3002\uff0e\uff61]\s*\p{L}{2,}/u,
  new RegExp(`\\bdot\\s*${TLD}\\b`, "iu"),
  /@/u,
  /\b(?:t|wa)\s*[.\s]?\s*me\b/iu,
  /\+?\p{Nd}(?:[\s\-().]*\p{Nd}){6,}/u,
  /\b0x[0-9a-f]{6,}/iu,
  /\bbc1[a-z0-9]{6,}/iu,
  /\p{Sc}/u,
];
/** `open` asks to open something, except "open to" (are you open to …). */
const OPEN_NOT_TO = /(?:^| )open(?:s|ed|ing)?(?! to(?: |$))/;
/** "enter a code", "the code we sent": a code to type in. */
const CODE_TO_ENTER = /(?:^| )(?:enter|type|give|share|send|read)(?: \p{L}+){0,2} code/u;

/** The first word of a question (no imperative start). */
const QUESTION_START = new Set(
  "who whom whose what which when where why how is are am was were do does did can could would will should shall may might have has had any anything anyone anybody in for with by from at on about within over".split(" "),
);
/** What a plain question may hold before its one final `?`. */
const PLAIN_CHARS = /^[\p{L}\p{M}\p{Nd} ,'’\-()&]+$/u;
/** Characters that are never shown: control, format, private use, surrogates, separators, default-ignorable, Hangul fillers. */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u115f\u1160\u3164\uffa0]/u;
/** A word joined by an underscore (`create_intent`, `source_type`): the shape of a tool or field name. */
const SNAKE_CASE = /\p{L}+_[\p{L}\p{N}_]*[\p{L}\p{N}]/u;

// ── The check readings: a COPY of ov#301's (intro/comms, proactive-text.ts
// lookalikeFold / matchFieldReadings and their helpers, at 4dadc91d). ov#302 is
// based on rc33 and cannot import them; unify with ov#301's when it lands. ──

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/gu;
const IGNORABLE = /[\p{Default_Ignorable_Code_Point}\u115f\u1160\u3164\uffa0]/gu;
const JOINER_RUNS = /['’\-&/]+/g;

const LOOKALIKES: Readonly<Record<string, string>> = Object.freeze({
  // Cyrillic lower case
  "а": "a", "с": "c", "ԁ": "d", "е": "e", "һ": "h", "і": "i", "ј": "j",
  "ӏ": "l", "о": "o", "р": "p", "ԛ": "q", "ѕ": "s", "ԝ": "w", "х": "x",
  "у": "y", "ү": "y", "ɡ": "g", "м": "m", "п": "n", "г": "r", "ԍ": "g",
  "т": "t", "ҽ": "e",
  // Cyrillic upper case
  "А": "a", "В": "b", "С": "c", "Е": "e", "Н": "h", "І": "i", "Ј": "j",
  "К": "k", "М": "m", "О": "o", "Р": "p", "Ѕ": "s", "Т": "t", "Х": "x",
  "У": "y", "Ү": "y", "Ԛ": "q", "Ԝ": "w", "Ӏ": "i", "Ԁ": "d",
  // Greek lower case
  "α": "a", "ε": "e", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p",
  "τ": "t", "υ": "u", "χ": "x", "ϲ": "c", "ϳ": "j", "γ": "y", "η": "n", "ω": "w",
  // Greek upper case
  "Α": "a", "Β": "b", "Ε": "e", "Ζ": "z", "Η": "h", "Ι": "i", "Κ": "k",
  "Μ": "m", "Ν": "n", "Ο": "o", "Ρ": "p", "Τ": "t", "Υ": "y", "Χ": "x",
  // Latin letters NFKC and NFD keep: dotless, stroked
  "ı": "i", "ȷ": "j", "ĸ": "k", "ø": "o", "Ø": "o", "ł": "l", "Ł": "l", "đ": "d", "Đ": "d",
  "ħ": "h", "Ħ": "h", "ŧ": "t", "Ŧ": "t", "ƀ": "b", "Ƀ": "b",
  // the kept Latin letters
  "æ": "ae", "Æ": "ae", "œ": "oe", "Œ": "oe", "ß": "ss", "ẞ": "ss", "ð": "d", "Ð": "d", "þ": "p", "Þ": "p", "ŋ": "n", "Ŋ": "n",
});

/** NFKC; invisible characters removed; combining marks removed; look-alike letters folded; lower case. Check only. */
function lookalikeFold(text: string): string {
  const plain = text.normalize("NFKC").replace(INVISIBLE, "").replace(IGNORABLE, "").normalize("NFD").replace(/\p{M}+/gu, "");
  return [...plain].map((ch) => LOOKALIKES[ch] ?? ch).join("").toLowerCase().normalize("NFKC");
}

const LEET: Readonly<Record<string, string>> = Object.freeze({ "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s" });
const LEET_L: Readonly<Record<string, string>> = Object.freeze({ ...LEET, "1": "l" });

function leetFold(folded: string, map: Readonly<Record<string, string>>): string {
  return folded
    .split(" ")
    .map((word) => (/\p{L}/u.test(word) && /[0-9@$]/.test(word) ? [...word].map((ch) => map[ch] ?? ch).join("") : word))
    .join(" ");
}

function camelSplit(text: string): string {
  return text.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2").replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2");
}

function capitalIAsL(text: string): string {
  return text.replace(/(?<=\p{Ll})[IІӀΙ]+|(?<![\p{L}\p{N}])[IІӀΙ]+(?=\p{Ll})/gu, (run) => "l".repeat([...run].length));
}
function smallLAsI(text: string): string {
  return text.replace(/(?<=\p{Lu})l+(?!\p{Ll})|(?<![\p{L}\p{N}])l+(?=\p{Lu})/gu, (run) => "I".repeat(run.length));
}

function pairsJoined(folded: string): string {
  return folded.replace(/rn/g, "m").replace(/vv/g, "w");
}

function notExpanded(folded: string): string {
  return folded
    .replace(/n't(?![\p{L}\p{N}])/gu, " not")
    .replace(/(?<![\p{L}\p{N}])dont(?![\p{L}\p{N}])/gu, "do not")
    .replace(/ +/g, " ")
    .trim();
}

/** The check copies of the text (never shown): ov#301's matchFieldReadings. */
export function questionReadings(text: string): string[] {
  const plain = text.replace(/’/g, "'");
  const readings = new Set<string>();
  for (const cased of new Set([plain, capitalIAsL(plain), smallLAsI(plain)])) {
    for (const base of new Set([cased, camelSplit(cased)])) {
      const folded = lookalikeFold(base);
      for (const digits of new Set([folded, leetFold(folded, LEET), leetFold(folded, LEET_L)])) {
        for (const form of new Set([digits, pairsJoined(digits)])) {
          readings.add(notExpanded(form));
          readings.add(notExpanded(form.replace(JOINER_RUNS, " ").replace(/ +/g, " ").trim()));
          readings.add(notExpanded(form.replace(JOINER_RUNS, "")));
        }
      }
    }
  }
  return [...readings];
}

/** The scanner's four phrases in a reading with every space and joiner removed. */
function joinedScanHit(joined: string): boolean {
  const ignore = joined.indexOf("ignore");
  if (ignore >= 0) {
    const end = joined.lastIndexOf("instructions");
    if (end > ignore && /previous|all|above|prior/.test(joined.slice(ignore + "ignore".length, end))) return true;
  }
  return /dono?ttelltheuser/.test(joined) || joined.includes("systempromptoverride") || /disregard(?:your|all|any)(?:instructions|rules|guidelines)/.test(joined);
}

// ── End of the ov#301 copy. ──

/** Each name's parts joined, to the part boundaries (offsets in the joined form) a match may have. */
const NAMES = new Map<string, Array<Set<number>>>();
let WINDOW = 1;
for (const name of TOOL_NAMES) {
  const parts = name.toLowerCase().split("-").filter(Boolean);
  WINDOW = Math.max(WINDOW, parts.length);
  const cuts = new Set<number>();
  let at = 0;
  for (const part of parts.slice(0, -1)) cuts.add((at += part.length));
  const joined = parts.join("");
  NAMES.set(joined, [...(NAMES.get(joined) ?? []), cuts]);
}

/** True when some run of consecutive tokens joins into a tool name, with its boundaries only where the name has one. */
function namesTool(tokens: readonly string[]): boolean {
  for (let i = 0; i < tokens.length; i++) {
    let joined = "";
    const cuts: number[] = [];
    for (let j = i; j < tokens.length && j < i + WINDOW; j++) {
      if (j > i) cuts.push(joined.length);
      joined += tokens[j];
      if (NAMES.get(joined)?.some((allowed) => cuts.every((cut) => allowed.has(cut)))) return true;
    }
  }
  return false;
}

/** Two or more adjacent tokens that read as one stop word (`i g n o r e`, `sen d`). */
function joinedStopHit(tokens: readonly string[]): boolean {
  for (let i = 0; i < tokens.length; i++) {
    let joined = tokens[i];
    for (let j = i + 1; j < tokens.length; j++) {
      joined += tokens[j];
      if (joined.length > JOINED_STOP_MAX) break;
      if (JOINED_STOPS.includes(joined)) return true;
    }
  }
  return false;
}

const tokensOf = (reading: string) => reading.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const SCRIPTS = ["Latin", "Cyrillic", "Greek", "Armenian", "Devanagari", "Arabic", "Hebrew", "Han", "Thai", "Hangul", "Hiragana", "Katakana", "Georgian", "Cherokee"].map(
  (name) => new RegExp(`\\p{Script=${name}}`, "u"),
);

/** Why the question must not reach the agent, or null. `line` is the resident's own refused line (quotes_line). Pure. */
export function questionGuardHit(raw: string, line?: string | null): GuardHit | null {
  if (HIDDEN.test(raw)) return "hidden";
  const text = raw.normalize("NFKC").trim();
  if (HIDDEN.test(text)) return "hidden";
  const words = text.split(/\s+/).filter(Boolean);
  if (words.some((word) => SCRIPTS.filter((script) => script.test(word)).length > 1)) return "confusable";
  const readings = questionReadings(text);
  if (cronScanHit(text) || readings.some((r) => cronScanHit(r) || joinedScanHit(r.replace(/[\s'\-&/]+/g, "").replace(/[^\p{L}\p{N}]+/gu, "")))) return "scanner";
  if (SNAKE_CASE.test(text)) return "tool_name";
  const tokenSets = readings.map(tokensOf);
  if (tokenSets.some(namesTool)) return "tool_name";
  if (DESTINATION_SHAPES.some((shape) => shape.test(text))) return "destination";
  if (words.some((word) => [...word].length >= 20 && /\p{L}/u.test(word) && /\p{Nd}/u.test(word))) return "destination";
  if (tokenSets.some((tokens) => tokens.some((t) => DESTINATION_WORD.test(t)))) return "destination";
  if (readings.some((r) => OPEN_NOT_TO.test(r) || CODE_TO_ENTER.test(r) || new RegExp(`(?:^| )dot ${TLD}(?: |$)`).test(r))) return "destination";
  if (tokenSets.some((tokens) => tokens.some((t, i) => STOP_WORD.test(t) || (t === "seed" && /^phrases?$/.test(tokens[i + 1] ?? ""))) || joinedStopHit(tokens))) return "stop_word";
  if (words.some((word) => /\p{L}/u.test(word) && /\p{Nd}/u.test(word))) return "mixed_word";
  const body = text.endsWith("?") ? text.slice(0, -1).trimEnd() : null;
  if (body === null || body.includes("?")) return "not_question";
  if (!PLAIN_CHARS.test(body)) return "shape";
  const first = lookalikeFold(words[0] ?? "").replace(/[^\p{L}]+/gu, "");
  if (!QUESTION_START.has(first)) return "not_question";
  if (line) {
    const flat = (s: string) => ` ${tokensOf(lookalikeFold(s)).join(" ")} `;
    const said = flat(line);
    if (said.trim().split(" ").length >= 3 && flat(text).includes(said)) return "quotes_line";
  }
  if ([...text].length > QUESTION_MAX) return "too_long";
  return null;
}

