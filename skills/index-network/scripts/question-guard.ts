/**
 * SEED-REVISION (ov#302 combined round): the guard on Index's recovery
 * question before the AGENTS.md welcome gate's REFUSED_SEEDS block hands it to
 * the agent's first chat turn (welcome.ts refusedQuestion). The question is
 * third-party, model-written text, so beyond Hermes's cron scanner and the
 * snake_case check it is withheld when it:
 *
 *   - mixes Latin letters with Cyrillic, Greek or Armenian ones in one word
 *     (`confusable`: a homoglyph spelling such as "іgnore");
 *   - names a tool (`tool_name`): TOOL_NAMES in any spelling, read as one
 *     token: snake_case, camelCase, PascalCase, hyphenated, spaced, joined,
 *     upper case, with zero-width or fullwidth separators, Cyrillic/Greek
 *     look-alike letters folded first. A spaced or camel form only matches
 *     where the name itself has a part boundary ("to do" is not `todo`);
 *   - holds a stop word (`stop_word`, STOP_WORD, with its inflections).
 *
 * Over-withholding is the safe side: the block then carries question null and
 * the agent asks the fixed "What would make it clearer?". Pure; never throws.
 */

/**
 * The tool names the guard reads: the av-events plugin's
 * (plugins/av-events/tool_categories.json `builtin` and `mcp.index`;
 * edgeos_tool_allowlist.json `carrier_tools`), the Index tools welcome.ts
 * calls (index-mcp.ts callIndexTool), and welcome.ts's own output markers.
 * Kept here, not read at run time, so the guard never depends on a plugin
 * file on the box; welcome-seed.test.ts fails when either file names a tool
 * this list misses.
 */
export const TOOL_NAMES: readonly string[] = `
  accept_opportunity add_contact archive_intent browser_back browser_cdp browser_click browser_console browser_dialog browser_exec
  browser_get_images browser_navigate browser_press browser_scroll browser_snapshot browser_type browser_vision cancel_discovery_run
  cancel_enrichment_run clarify complete_onboarding confirm_opportunity_delivery confirm_user_context consent_status create_intent
  create_intent_index create_network create_network_membership create_premise create_user_context cronjob delegate_task delete_agent
  delete_intent delete_intent_index delete_network delete_network_membership discover_opportunities enrich_my_profile execute_code
  get_conversation get_discovery_run get_enrichment_run get_intent get_my_profile get_negotiation get_opportunity grant_agent_permission
  image_generate import_contacts import_gmail_contacts index_add_intent_to_network index_agent_me index_create_intent index_create_network
  index_join_network index_list_intent_networks index_list_opportunities index_read_docs index_read_intents index_read_network_memberships
  index_read_networks index_research_profile index_update_intent index_update_network index_update_opportunity list_agents list_contacts
  list_conversations list_intents list_negotiations list_opportunities memory opportunity_outcome patch pause_intent preview_user_context
  process read_docs read_file read_intent_indexes read_intents read_network_memberships read_networks read_pending_questions read_premises
  read_user_contexts recall record_intention record_onboarding_privacy_consent register_agent reject_opportunity remove_contact resume_intent
  retract_premise revoke_agent_permission scrape_url search_contacts search_files search_intents send_message session_search skill_manage
  skill_view skills_list terminal text_to_speech todo update_agent update_intent update_my_profile update_network update_opportunity
  update_premise update_user_context video_analyze vision_analyze web_extract web_search write_file x_search
  welcome_already_sent refused_seeds
`
  .trim()
  .split(/\s+/);

/** The words that withhold a question, whole words, with their inflections (the lead's list for ov#302's combined round). */
const STOP_WORD =
  /^(?:ignor(?:e|es|ed|ing)|instructions?|systems?|prompts?|overrid(?:e|es|ing|den)|overrode|tools?|call(?:s|ed|ing)?|publish(?:es|ed|ing)?|approv(?:e|es|ed|ing|al)|passwords?|wallets?|telegram|send(?:s|ing)?|sent|forward(?:s|ed|ing)?|delet(?:e|es|ed|ing|ion)|seedphrases?)$/;
/** "seed phrase" as two words. */
const SEED = "seed";
const PHRASE = /^phrases?$/;

/** Look-alike letters folded to Latin before the name and word checks (lower case). */
const CONFUSABLE: Readonly<Record<string, string>> = {
  // Cyrillic
  а: "a", в: "b", е: "e", ё: "e", о: "o", р: "p", с: "c", у: "y", х: "x", і: "i", ї: "i", ј: "j", ѕ: "s", ԁ: "d", ӏ: "l", һ: "h", ԛ: "q", ԝ: "w", к: "k", м: "m", т: "t", н: "h", п: "n", г: "r",
  // Greek
  α: "a", β: "b", ε: "e", η: "n", ι: "i", κ: "k", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x", γ: "y", ω: "w",
  // Armenian
  օ: "o", ս: "u", ո: "n", հ: "h", ց: "g", զ: "q",
};
const LATIN = /\p{Script=Latin}/u;
const LOOK_ALIKE_SCRIPT = /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}]/u;
/** Code points that render as nothing (format, default-ignorable, Hangul fillers): stripped so they cannot split a name. */
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}ᅟᅠㅤﾠ]/gu;
const WORD = /[\p{L}\p{M}\p{N}]+/gu;
/** camelCase and PascalCase part boundaries: aB, and ABc (an acronym before a word). */
const CAMEL = /(?<=[\p{Ll}\p{N}])(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u;

/** Each name's parts joined, to the part boundaries (offsets in the joined form) a match may have. */
const NAMES = new Map<string, Array<Set<number>>>();
let WINDOW = 1;
for (const name of TOOL_NAMES) {
  const parts = name.toLowerCase().split("_").filter(Boolean);
  WINDOW = Math.max(WINDOW, parts.length);
  const cuts = new Set<number>();
  let at = 0;
  for (const part of parts.slice(0, -1)) cuts.add((at += part.length));
  const joined = parts.join("");
  NAMES.set(joined, [...(NAMES.get(joined) ?? []), cuts]);
}

function fold(part: string): string {
  return [...part.toLowerCase()].map((ch) => CONFUSABLE[ch] ?? ch).join("");
}

/** The text's words (NFKC, invisibles stripped), then their parts (camel boundaries), folded. */
function wordsOf(text: string): string[] {
  return text.normalize("NFKC").replace(INVISIBLE, "").match(WORD) ?? [];
}

/** True when some run of consecutive parts joins into a tool name, with its boundaries only where the name has one. */
function namesTool(parts: string[]): boolean {
  for (let i = 0; i < parts.length; i++) {
    let joined = "";
    const cuts: number[] = [];
    for (let j = i; j < parts.length && j < i + WINDOW; j++) {
      if (j > i) cuts.push(joined.length);
      joined += parts[j];
      if (NAMES.get(joined)?.some((allowed) => cuts.every((cut) => allowed.has(cut)))) return true;
    }
  }
  return false;
}

export type GuardHit = "confusable" | "tool_name" | "stop_word";

/** Why `text` must not reach the agent (beyond the scanner and snake_case, which the caller runs), or null. Pure. */
export function questionGuardHit(text: string): GuardHit | null {
  const words = wordsOf(text);
  if (words.some((word) => LATIN.test(word) && LOOK_ALIKE_SCRIPT.test(word))) return "confusable";
  const parts = words.flatMap((word) => word.split(CAMEL)).map(fold).filter(Boolean);
  if (namesTool(parts)) return "tool_name";
  if (parts.some((part, i) => STOP_WORD.test(part) || (part === SEED && PHRASE.test(parts[i + 1] ?? "")))) return "stop_word";
  return null;
}
