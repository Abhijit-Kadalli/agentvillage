# Mini-apps generic approval card: the formatter spec

Mini-apps v2 Phase 1 item 6 (design `MINIAPPS-PLATFORM-v2-design.md` section 3). A `needs-card` operation of any catalog
app gets the For Kicks minimal card: four plain strings, each drawn whole and unmarked, or no card at all. Three codebases
build or check the same four strings, so this file is the one spec and `mini-app-card.json` (next to it) is the golden
vector set. The app and the control plane copy the JSON byte for byte into their own tests and must produce the same
output for every vector.

Implementation of record (the box): `plugins/village-bridge/_mini_app_card.py` `card_fields`, which reuses For Kicks'
`card_value_fits` and `card_name_fakes_line` from `_forkicks.py` by import. For Kicks' own card
(`forkicks-approval-card.{md,json}`) is unchanged this train; its preview is re-expressed here through a declaration
(two vectors), so one engine renders both.

## Input

- `declaration`: the needs-card op's manifest `approval.card`, exactly
  `{ "item": <path>, "total": <path>, "when": <path>, "shared": <path>, "bind": [[<requestPath>, <previewPath>], ...] }`.
  `bind` is required (it may be empty) and holds at most 32 pairs.
- `preview`: the prepare op's preview (the object the app stores and returns beside the payload).
- `request` (optional): the prepare op's arguments, as the box sent them. When given, every `bind` pair is checked for
  equality. The control plane has no request and passes none; the app and the box pass it.

A **path** is 1 to 8 segments joined by `.`, each segment `[A-Za-z_][A-Za-z0-9_]{0,63}`. No `$.` prefix, no array
index, no wildcard. A path walks objects only.

**Reserved keys.** The top-level preview keys `appId` and `draftId` are bound by the approval key
(`...:<draftId>`) and the per-draft record; they are never shown or bound by a declaration, and the coverage rule below
skips them. Their values are the caller's check (the box: equal to the app id and the draft id it is confirming).

## Output

- `card`: exactly `{item, total, when, shared}`, each the string at its declared path, verbatim.
- `payloadHash`: sha256 (lowercase hex) of the canonical JSON of `card`: keys sorted, no whitespace
  (`","` and `":"`), UTF-8, non-ASCII characters written as themselves (Python `ensure_ascii=False`, JavaScript
  `JSON.stringify` of the sorted object).
- `summary`: the text the box proposes beside the payload (the technical card's "Full details"):
  `What: <item>` U+000A `Total: <total>` U+000A `When & where: <when>` U+000A `Shared with: <shared>`. The labels are
  approval's (L19771) and are listed in the JSON's `labels`; the card's own row labels live in the cp policy template's
  say entry for the class (approval's commit, not these lanes).
- or `error`: one of the codes below.

## The checks, in order (so the three implementations return the same code)

1. **Declaration.** Absent (`null` / missing): `approval_card_undeclared` (the box never proposes). Not exactly the five
   keys, a path that is not a path, a `bind` entry that is not a pair of paths, more than 32 pairs, a shown or bound
   preview path whose first segment is `appId` or `draftId`, two shown paths equal, or one shown path a segment prefix
   of another: `approval_card_invalid`.
2. **Preview** is not an object: `approval_card_invalid`.
3. **Shown paths.** Each of the four resolves (every segment an existing key of an object) to a string. A missing
   segment, a walk through a non-object, or a non-string value (number, boolean, null, list, object):
   `approval_card_invalid`.
4. **Bind.** Each `previewPath` resolves (to any value). With a `request`: each `requestPath` resolves in it, and the two
   values are equal as canonical JSON (so `2` differs from `"2"`, and `true` differs from `1`). Otherwise
   `approval_card_invalid`.
5. **Shown or bound** (design 3.2; review-a S1 on cp#286). Walk the preview: descend into objects; every other value
   (string, number, boolean, null, list) and every empty object is a leaf. Each leaf's path must equal a shown path, or
   start with (or equal) a bound `previewPath`, segment by segment. Every key on the way must itself be a valid segment.
   Top-level `appId` and `draftId` are skipped. A leaf neither shown nor bound, a key that is not a segment, or nesting
   deeper than 16 objects: `approval_card_invalid`. So nothing the app hashes can change what the card describes
   without being shown, or bound to what the box sent.
6. **No text breaks a line or a direction.** Any character of Unicode category Cc, Cf, Cs, Zl or Zp in a shown string
   (U+000A, U+000D, tab, U+0085, U+2028, U+2029, bidi controls, zero-width characters): `approval_card_invalid`. The one
   exception: U+000A between the lines of `item`.
7. **Minimal-card fit** (For Kicks' rule, approval-md 0.4.7 `telegram-minimal`): each value passes
   `card_value_fits` (1 to 278 code points, counting each U+000A of `item` as 3 because core draws it as ` ⏎ `; only
   U+0020 spaces, letters, numbers, punctuation and symbols other than `«` U+00AB, `⏎` U+23CE, U+115F, U+1160, U+3164,
   U+FFA0, U+2800; combining marks other than the default-ignorable ones, at most 2 in a row). Also: no value is blank
   (only U+0020), no line of `item` is blank (no empty, leading or trailing line), and `item` holds no character that
   draws like core's line mark after NFKC (U+23CE and the arrow and control-picture blocks of `card_name_fakes_line`).
   Otherwise `approval_card_not_minimal`. A string that does not fit is never cut.
8. **Summary budget.** The summary over 4096 UTF-8 bytes, or over 3000 bytes once `&`, `<`, `>` are escaped as
   `&amp;`, `&lt;`, `&gt;` (For Kicks' `SUMMARY_MAX_BYTES` / `SUMMARY_HTML_MAX_BYTES`): `approval_card_too_long`.

## What the codes mean downstream

- The app (prepare): a refusal means no draft is stored and the resident sees no card; the agent gets the code. There is
  no legacy shape for a generic app this train.
- The box: `approval_card_undeclared` and every refusal at prepare or confirm stop before any propose; nothing is ever
  proposed with strings it did not re-derive itself.
- The control plane (`request()`): any refusal is a refused approval request.

## Card class and key (CARD-COMMON item 3)

The parent `marketplace.app.action` is autonomous for everyone. A generic needs-card op proposes under its MEMBER class
`marketplace.app.action.<operation>`, where `<operation>` is the op's full name and its first segment is the app id
(e.g. `marketplace.app.action.acme.rental.confirm`; the same shape as the `marketplace.app.action.gold-stars.send` member
row), with key `<class>:<draftId>`; payload = the canonical `card`, summary = `summary`. The daemon must answer `requested` (a member row approval pinned to ask); `autonomous` (no member
row yet) is refused `approval_card_unpinned` and nothing runs.

## Vectors

`vectors[]`: `{name, declaration, preview, request?, card, payloadHash, summary}` or
`{name, declaration, preview, request?, error}`. Vectors are Unicode-version-neutral (no code point newer than
Unicode 14), as For Kicks' are. All data is invented.
