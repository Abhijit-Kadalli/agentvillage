/**
 * VISIBILITY MARKS (CLAIMS L13696): the overlay's two USER.md card-line readers, context-tags.ts
 * (parseContextTags, parseContextLine) and memory_signal_gate.py (ITEM_LINE, parse_item_line,
 * context_tags), accept the old marks (`public`, `village`, `private`: the e3 wire today) AND the
 * ids of agentvillage.visibility/1 (`agentvillage/edgecityindia2026`, `agentvillage/private`: the wire
 * a later release switches to), and read both to the same visibility. Writers are unchanged.
 *
 *   - the vocab pin: the ids and the mark mapping are the vocab's, by sha256;
 *   - the table: every old mark and every new id, under every marker form, read identically by
 *     TypeScript and Python, old and new to the same visibility;
 *   - anything else stays part of the words, as today; a guess or a chat line is Private whatever
 *     its mark; no mark ever reads wider than the vocab says;
 *   - the golden: today's inputs give byte-identical outputs (fixtures/context-marks-golden.json,
 *     from origin/main fe243b06's readers).
 *
 *   bun test skills/index-network/scripts/tests/context-marks.test.ts
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import {
  CONTEXT_TAGS_MARK,
  ITEM_LINE_SOURCE,
  MARK_VISIBILITY,
  VISIBILITY_EDGE_CITY_INDIA_2026,
  VISIBILITY_IDS,
  VISIBILITY_PRIVATE,
  VISIBILITY_VOCAB,
  type Visibility,
  markVisibility,
  parseContextLine,
  parseContextTags,
  statedItems,
} from "../context-tags";
import { MARKER_FORMS, NEW_MARKS, NOT_MARKS, OLD_MARKS, entryFor, goldenFor, pyOutputs, pyRun, todayEntries, tsOutputs } from "./context-marks-corpus";

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

/**
 * The vocab pin. Source: Edge-City/agentvillage-app src/lib/visibility/visibility-vocab.v1.json at
 * app main ee8dc195 (app#468), byte-identical to Edge-City/agentvillage-controlplane
 * control-plane/src/visibility/visibility-vocab.v1.json at cp main f8ec6165 (cp#321); both repos'
 * visibility-pins.v1.json pin the same sha256. This repo is public, so the file itself is not copied
 * here: VOCAB_SUBSET_SHA256 is the sha256 of the part the readers use, encoded as
 * JSON.stringify({vocab, ids, mark: mapping.mark, mark_of_a_guess: mapping.mark_of_a_guess,
 * unknown: mapping.unknown}) over that file. A vocab change (a new id, a new mapping) breaks this pin,
 * and the readers here move with it. With AV_VISIBILITY_VOCAB_FILE set to a copy of the file, the test
 * also checks the file's own sha256 and recomputes the subset from it.
 */
const VOCAB_FILE_SHA256 = "b7a02a2149aa2c99f309e223ecef80ffe52844f128b9646f1eef5d4fb2639521";
const VOCAB_SUBSET_SHA256 = "5467406579673c5ac7622208e418204110a0a456d608abb5171f36258895e5bf";
const VOCAB_SUBSET = {
  vocab: "agentvillage.visibility/1",
  ids: ["agentvillage/private", "agentvillage/edgecityindia2026"],
  mark: {
    public: "agentvillage/edgecityindia2026",
    village: "agentvillage/edgecityindia2026",
    private: "agentvillage/private",
    "": "agentvillage/private",
  },
  mark_of_a_guess: "agentvillage/private",
  unknown: "agentvillage/private",
};
/** Who reads each id (the vocab's `readers`): the no-widening check compares these sets. */
const READERS: Record<Visibility, readonly string[]> = {
  "agentvillage/private": ["agent"],
  "agentvillage/edgecityindia2026": ["agent", "index", "skylight"],
};
const OLD_TO_NEW: Record<string, Visibility> = { public: VISIBILITY_EDGE_CITY_INDIA_2026, village: VISIBILITY_EDGE_CITY_INDIA_2026, private: VISIBILITY_PRIVATE };

/** origin/main fe243b06's LINE (context-tags.ts:89), to show what today's reader made of a new id. */
const LINE_FE243B06 = /^- (.+?)(?:\s+\((setup|telegram|you|guess|chat)(?:,\s*intros chat\s+([0-9a-f]{12})|,\s*(guess))?(?:,\s*(public|village|private))?\))?$/i;

const isGuessForm = (form: string) => /guess/i.test(form);
const isChatForm = (form: string) => /^chat$/i.test(form);
const expectedMarker = (form: string) => {
  const f = form.toLowerCase();
  if (f === "chat, guess") return "guess";
  return f.split(",")[0]!.trim();
};

describe("the vocab pin", () => {
  test("the overlay's ids and mark mapping are the vocab's, by sha256", () => {
    expect(sha256(JSON.stringify(VOCAB_SUBSET))).toBe(VOCAB_SUBSET_SHA256);
    const ours = {
      vocab: VISIBILITY_VOCAB,
      ids: [...VISIBILITY_IDS],
      mark: {
        public: markVisibility("public", false),
        village: markVisibility("village", false),
        private: markVisibility("private", false),
        "": markVisibility(null, false),
      },
      mark_of_a_guess: markVisibility("public", true),
      unknown: markVisibility("everyone", false),
    };
    expect(JSON.stringify(ours)).toBe(JSON.stringify(VOCAB_SUBSET));
    expect(sha256(JSON.stringify(ours))).toBe(VOCAB_SUBSET_SHA256);
  });

  test("the marks are exactly the old three and the vocab's ids, each id naming itself", () => {
    expect(Object.keys(MARK_VISIBILITY).sort()).toEqual([...Object.keys(OLD_TO_NEW), ...VISIBILITY_IDS].sort());
    for (const [old, id] of Object.entries(OLD_TO_NEW)) expect([old, MARK_VISIBILITY[old]]).toEqual([old, id]);
    for (const id of VISIBILITY_IDS) expect([id, MARK_VISIBILITY[id]]).toEqual([id, id]);
    expect(Object.isFrozen(MARK_VISIBILITY)).toBe(true);
  });

  test.skipIf(!process.env.AV_VISIBILITY_VOCAB_FILE)("AV_VISIBILITY_VOCAB_FILE: the app/cp file hashes to the pin and holds the same subset", () => {
    const bytes = readFileSync(process.env.AV_VISIBILITY_VOCAB_FILE!);
    expect(sha256(bytes)).toBe(VOCAB_FILE_SHA256);
    const v = JSON.parse(bytes.toString("utf8"));
    const subset = { vocab: v.vocab, ids: v.ids, mark: v.mapping.mark, mark_of_a_guess: v.mapping.mark_of_a_guess, unknown: v.mapping.unknown };
    expect(JSON.stringify(subset)).toBe(JSON.stringify(VOCAB_SUBSET));
  });

  test("Python holds the same constants and the same line pattern", () => {
    const py = pyRun({ constants: true }).constants!;
    expect(py.vocab).toBe(VISIBILITY_VOCAB);
    expect(py.ids).toEqual([...VISIBILITY_IDS]);
    expect(py.marks).toEqual({ ...MARK_VISIBILITY });
    expect(py.pattern).toBe(ITEM_LINE_SOURCE);
  });
});

describe("the table: every old mark and every new id, TypeScript and Python alike", () => {
  const MARKS = [...OLD_MARKS, ...NEW_MARKS];
  const lines: string[] = [];
  for (const mark of MARKS) for (const form of MARKER_FORMS) lines.push(`- Item words (${form}, ${mark})`);
  for (const mark of MARKS) lines.push(`- Item words (you,${mark})`, `- Item words (setup,   ${mark})`);
  const py = pyRun({ lines }).lines;

  test("every line is read: the words alone, the marker, the mark lower-cased, its visibility", () => {
    let i = 0;
    for (const mark of MARKS) {
      for (const form of MARKER_FORMS) {
        const line = lines[i++]!;
        const read = parseContextLine(line);
        const marker = expectedMarker(form);
        const vis = isGuessForm(form) || isChatForm(form) ? VISIBILITY_PRIVATE : MARK_VISIBILITY[mark.toLowerCase()]!;
        expect([line, read]).toEqual([line, { text: "Item words", marker, mark: mark.toLowerCase(), visibility: vis }]);
      }
    }
  });

  test("Python's parse_item_line gives the same answer for every line", () => {
    lines.forEach((line, i) => {
      const ts = parseContextLine(line)!;
      expect([line, py[i]]).toEqual([line, [ts.text, ts.marker, ts.mark, ts.visibility]]);
    });
  });

  test("an old mark and its new id read the same: words, marker and visibility", () => {
    for (const form of MARKER_FORMS) {
      for (const [old, id] of [["public", VISIBILITY_EDGE_CITY_INDIA_2026], ["village", VISIBILITY_EDGE_CITY_INDIA_2026], ["private", VISIBILITY_PRIVATE]] as const) {
        const a = parseContextLine(`- Item words (${form}, ${old})`)!;
        const b = parseContextLine(`- Item words (${form}, ${id})`)!;
        expect([form, old, a.text, a.marker, a.visibility]).toEqual([form, old, b.text, b.marker, b.visibility]);
      }
    }
  });

  test("a whole entry with the new ids reads as the same entry with the old marks (and as the unmarked one)", () => {
    const oldEntry = entryFor("village", "Same");
    const newEntry = entryFor(VISIBILITY_EDGE_CITY_INDIA_2026, "Same");
    const privOld = entryFor("private", "Same");
    const privNew = entryFor(VISIBILITY_PRIVATE, "Same");
    const plain = entryFor(null, "Same");
    const base = parseContextTags(plain);
    for (const e of [oldEntry, newEntry, privOld, privNew]) expect(parseContextTags(e)).toEqual(base);
    for (const g of ["here", "work", "meet", "offer", "curious", "prefs", "fun", "about"] as const) expect(statedItems(parseContextTags(newEntry), g)).toEqual(statedItems(base, g));
    const [pPlain, pOld, pNew, pPrivOld, pPrivNew] = pyOutputs([plain, oldEntry, newEntry, privOld, privNew]);
    for (const p of [pOld, pNew, pPrivOld, pPrivNew]) expect(p).toBe(pPlain!);
  });

  test("the hazard this closes: today's reader took a new id as words, so a guess read as stated", () => {
    const line = `- A seed library (guess, ${VISIBILITY_PRIVATE})`;
    const before = LINE_FE243B06.exec(line)!;
    expect([before[1], before[2]]).toEqual([`A seed library (guess, ${VISIBILITY_PRIVATE})`, undefined]); // read as an unmarked (telegram) item
    const tags = parseContextTags(`${CONTEXT_TAGS_MARK}\nWorking on:\n${line}\n- Tool library (you, ${VISIBILITY_EDGE_CITY_INDIA_2026})`);
    expect(tags.groups.work).toEqual([{ text: "A seed library", marker: "guess" }, { text: "Tool library", marker: "you" }]);
    expect(statedItems(tags, "work")).toEqual(["Tool library"]);
    expect(JSON.stringify(tags)).not.toMatch(/agentvillage/);
  });
});

describe("anything else is still no mark, exactly as today", () => {
  const lines = NOT_MARKS.flatMap((token) => [`- Item words (you, ${token})`, `- Item words (guess, ${token})`, `- Item words (chat, guess, ${token})`]);
  const py = pyRun({ lines }).lines;

  test("the parenthesis stays part of the words: an unmarked (telegram) item, Private", () => {
    for (const line of lines) {
      expect([line, parseContextLine(line)]).toEqual([line, { text: line.slice(2), marker: "telegram", mark: null, visibility: VISIBILITY_PRIVATE }]);
      // and today's reader did the same
      const before = LINE_FE243B06.exec(line)!;
      expect([line, before[1], before[2]]).toEqual([line, line.slice(2), undefined]);
    }
  });

  test("Python agrees on every one", () => {
    lines.forEach((line, i) => expect([line, py[i]]).toEqual([line, [line.slice(2), "telegram", null, VISIBILITY_PRIVATE]]));
  });

  test("a mark is only ever the last thing in the parenthesis, never two", () => {
    expect(parseContextLine(`- W (you, private, ${VISIBILITY_PRIVATE})`)!.marker).toBe("telegram");
    expect(parseContextLine(`- W (you, ${VISIBILITY_PRIVATE}, private)`)!.marker).toBe("telegram");
    expect(parseContextLine(`- W (${VISIBILITY_PRIVATE})`)).toEqual({ text: `W (${VISIBILITY_PRIVATE})`, marker: "telegram", mark: null, visibility: VISIBILITY_PRIVATE });
  });
});

describe("never wider: a narrower mark is never read as a wider one", () => {
  const MARK_INPUTS: (string | null)[] = [null, "", ...OLD_MARKS, ...NEW_MARKS, ...NOT_MARKS, "hasOwnProperty", "toString", "valueOf"];
  const cases: [string | null, boolean][] = MARK_INPUTS.flatMap((m) => [[m, false], [m, true]] as [string | null, boolean][]);
  const py = pyRun({ marks: cases }).marks;

  const GUESS_ANSWER = VOCAB_SUBSET.mark_of_a_guess as Visibility;
  /** The vocab's answer (its visibilityOfMark, over the old marks), with each id naming itself. */
  function vocabAnswer(mark: string | null, guess: boolean): Visibility {
    if (guess) return GUESS_ANSWER;
    const m = (mark ?? "").toLowerCase();
    if (Object.prototype.hasOwnProperty.call(VOCAB_SUBSET.mark, m)) return VOCAB_SUBSET.mark[m as keyof typeof VOCAB_SUBSET.mark] as Visibility;
    if ((VOCAB_SUBSET.ids as string[]).includes(m)) return m as Visibility;
    return VOCAB_SUBSET.unknown as Visibility;
  }

  test("markVisibility is the vocab's answer for every mark and guess flag, in both languages", () => {
    cases.forEach(([mark, guess], i) => {
      const ours = markVisibility(mark, guess);
      expect([mark, guess, ours]).toEqual([mark, guess, vocabAnswer(mark, guess)]);
      expect([mark, guess, py[i]]).toEqual([mark, guess, ours]);
      for (const reader of READERS[ours]) expect(READERS[vocabAnswer(mark, guess)]).toContain(reader);
    });
  });

  test("a guess flag that is not exactly false is a guess (fail closed)", () => {
    for (const g of [true, undefined, null, 0, "", "false"] as unknown as boolean[]) expect(markVisibility("public", g)).toBe(VISIBILITY_PRIVATE);
  });

  test("private, old or new, is never Edge City India 2026; a guess or a chat line never is, whatever its mark", () => {
    for (const mark of ["private", "PRIVATE", VISIBILITY_PRIVATE, VISIBILITY_PRIVATE.toUpperCase()]) {
      for (const form of MARKER_FORMS) expect(parseContextLine(`- W (${form}, ${mark})`)!.visibility).toBe(VISIBILITY_PRIVATE);
    }
    for (const mark of [...OLD_MARKS, ...NEW_MARKS]) {
      for (const form of MARKER_FORMS.filter((f) => isGuessForm(f) || isChatForm(f))) expect(parseContextLine(`- W (${form}, ${mark})`)!.visibility).toBe(VISIBILITY_PRIVATE);
    }
    expect(parseContextLine("- W (you)")!.visibility).toBe(VISIBILITY_PRIVATE);
    expect(parseContextLine("- W")!.visibility).toBe(VISIBILITY_PRIVATE);
  });
});

describe("the golden: today's inputs give byte-identical outputs", () => {
  const golden = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "context-marks-golden.json"), "utf8"));
  const now = goldenFor(golden.generated_at);

  test("the golden is origin/main fe243b06's, over this corpus", () => {
    expect(golden.generated_at).toBe("fe243b06ff70519b739bbe7872982f7a4df6ed53");
    expect(now.corpus_sha256).toBe(golden.corpus_sha256);
    expect(now.entries.map((e) => [e.name, e.entry_sha256])).toEqual(golden.entries.map((e: { name: string; entry_sha256: string }) => [e.name, e.entry_sha256]));
    expect(now.entries.length).toBe(todayEntries().length);
    expect(now.entries.length).toBeGreaterThanOrEqual(30);
  });

  test("TypeScript: every entry's outputs are byte-identical", () => {
    for (let i = 0; i < now.entries.length; i++) expect([now.entries[i]!.name, now.entries[i]!.ts_sha256]).toEqual([golden.entries[i].name, golden.entries[i].ts_sha256]);
  });

  test("Python: every entry's outputs are byte-identical", () => {
    for (let i = 0; i < now.entries.length; i++) expect([now.entries[i]!.name, now.entries[i]!.py_sha256]).toEqual([golden.entries[i].name, golden.entries[i].py_sha256]);
  });

  test("the corpus is not vacuous: it holds stated items, guesses, removals and words that kept a parenthesis", () => {
    const out = JSON.parse(tsOutputs(todayEntries().find((e) => e.name === 'not a mark "agentvillage/private "')!.entry));
    expect(out.stated.here.length).toBeGreaterThan(0);
    expect(JSON.stringify(out.tags)).toContain("agentvillage/private )");
    const old = JSON.parse(tsOutputs(todayEntries().find((e) => e.name === "old mark village")!.entry));
    expect(old.tags.groups.here.some((it: { marker: string }) => it.marker === "guess")).toBe(true);
    expect(old.tags.removed.length).toBe(3);
  });
});

describe("writers are unchanged: nothing in the overlay writes a new id", () => {
  test("only the two readers (and these tests) name an id", () => {
    const REPO = join(import.meta.dir, "..", "..", "..", "..");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === ".git" || name.startsWith(".test-deps")) continue;
        const path = join(dir, name);
        const st = statSync(path);
        if (st.isDirectory()) walk(path);
        else if (st.size < 2_000_000 && /\.(ts|js|py|md|json|ya?ml|sh)$/.test(name)) {
          const text = readFileSync(path, "utf8");
          if (text.includes("agentvillage/private") || text.includes("agentvillage/edgecityindia2026")) hits.push(relative(REPO, path));
        }
      }
    };
    for (const top of ["install", "plugins", "skills", "workspace", "scripts", "mini-apps", "docs"]) walk(join(REPO, top));
    expect(hits.sort()).toEqual([
      "skills/index-network/scripts/context-tags.ts",
      "skills/index-network/scripts/memory_signal_gate.py",
      "skills/index-network/scripts/tests/context-marks-corpus.ts",
      "skills/index-network/scripts/tests/context-marks.test.ts",
      "skills/index-network/scripts/tests/fixtures/context-marks-golden.json",
    ]);
  });
});
