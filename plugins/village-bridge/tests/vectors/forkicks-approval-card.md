# For Kicks flat approval card: the formatter spec

Carter's P0 (21 Oct): a For Kicks order is approved on the plain minimal card, not the technical one and
not an "AI summary (not checked)" line. Product ruling L17668 (a), For Kicks owner nonav L17670/L17696/L17701,
approval L17700/L17702. Three codebases build or check the same four strings, so this file is the one
spec and `forkicks-approval-card.json` (next to it) is the golden vector set. The app and the control plane
copy the JSON byte for byte into their own tests and must produce the same output for every vector.

Implementation of record (the box): `plugins/village-bridge/_forkicks.py` `card_fields`, `card_value_fits`.

## Who does what

| Part | Owner | What |
|---|---|---|
| App (`agentvillage-app` forkicks.ts) | context, ships LAST | At prepare, builds `approvalPayload` = exactly `{order, total, pickup, name}` from the saved draft and hashes it (payload_hash, as today). Returns the order's `preview` (today's `OrderPreview`) BESIDE `approvalPayload` in the prepare answer. At confirm, re-derives the four strings from the SAVED draft and refuses any difference. If the formatter refuses with `approval_card_not_minimal`, sends today's legacy `{appId, operation, preview}` payload instead. |
| Box (overlay `_forkicks.py`, v2.1.10 hotfix) | release, ships FIRST | Accepts both shapes. For the four-key shape it re-derives the strings from the `preview` the app returned beside the payload (saved in the per-draft record) and refuses a mismatch (`approval_card_invalid`) or an over-budget card (`approval_card_not_minimal`). Proposes the app's payload byte for byte, both shapes under the unchanged class `marketplace.app.action` and key `marketplace.app.action:forkicks.order.confirm:<draftId>` (approval L17713: no class change). |
| Control plane | context, after the box | The parent class's say entry quoting the four keys (below); `mini-apps-approval.js` request()/verify accept the four-key payload under the same key, bound to the draft (the draftId and order are no longer inside the payload). |

ORDER (nonav L17692): if the app emits the four-key shape before every box accepts it, every box before this
change refuses every order. Box tag + fleet update first, then the control plane, then the app. GATE (context
L17737): a box with this change sends `X-Village-Forkicks-Card: 1` on `forkicks.order.prepare` (and on no other
operation); the app emits the four-key payload ONLY on a prepare that carries it, so a box without it keeps
getting the legacy shape.

## The four strings

Input: the app's order preview `p` (keys `appId, draftId, quote, displayName, items, fulfilment, paymentMethod`,
optional `note`). Every check of today's technical card (`approval_summary` / the control plane's
`forkicksSummary`) runs first; any failure there is `approval_card_invalid`.

- `order`: one entry per `p.quote.lines[i]`, in order: `<qty> × <name>`, then ` (<options joined by ", ">)` when
  the line has options. A line with NO options has no parentheses at all (`1 × Butter croissant`, never
  `(none)`; CONFIRMED L17744). Entries joined by `"; "` (U+003B U+0020). `×` is U+00D7 with one U+0020 on each side. Names and
  options are the merchant's text, verbatim (no quoting). Every line is listed; nothing is cut.
- `total`: `₹<p.quote.totalInr>, <payment words>`. `₹` is U+20B9; the amount is the integer in decimal, no
  separators. Payment words: `upi` -> `pay by UPI`, `card_on_pickup` -> `card at pickup`. **Product-confirm.**
- `pickup`: `<where> · <when>`; the separator is ` · ` (U+0020 U+00B7 U+0020). CONFIRMED (L17744).
  - where: `p.quote.location.name` when `p.fulfilment.type` is `pickup`; `Delivery to <p.fulfilment.deliveryAddress>`
    (verbatim) when it is `delivery`. CONFIRMED (product + lead L17744).
  - when: the date `p.fulfilment.date` when present, else the first 10 characters of `p.quote.location.opens`
    (the same date as the technical card's `Date (IST)`), written `<day> <Mon> <year>`: day without a leading
    zero, the month as `Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec`, e.g. `5 Nov 2026`. No weekday, no
    time, no "today" (the strings are re-derived later and must not depend on the clock; the quote's `closes`
    is optional). A month outside 1-12 or a day outside 1-31 is `approval_card_invalid`. **Product-confirm.**
- `name`: `p.displayName`, verbatim.

## What you see is what the order sends (security review)

The four rows must show everything the order sends that the agent can influence. Every preview field is either
shown, bound to a shown one, or the flat card is refused with `approval_card_invalid` (the app then sends the
legacy shape for that draft, whose technical card shows everything):

| Preview field | On the flat card |
|---|---|
| `appId` | constant `forkicks` (checked) |
| `draftId` | bound: the per-draftId approval key and record |
| `displayName` | shown (Name) |
| `paymentMethod` | shown (Total) |
| `quote.lines[i]` name, qty, options | shown (Order); `unitInr`/`lineInr` are the merchant's prices behind the shown Total |
| `quote.lines[i]` itemId, optionIds | bound: must equal `items[i]` (else refused) |
| `quote.totalInr`, `quote.location.name` | shown (Total, Pickup) |
| rest of `quote` | the merchant's own answer for this quoteId, not text the agent sends |
| `items[i]` | exactly `{itemId, optionIds, qty}`, equal to `quote.lines[i]` (else refused) |
| `fulfilment` | exactly `type` (shown), `locationId` (must equal `quote.location.id` / `quote.locationId` when present), `date` (shown), `deliveryAddress` (shown; only on a delivery, else refused); any other key refused |
| `note` | agent-written text sent to the café, NOT on the four rows: a non-empty `note` REFUSES the flat card |

So the APP must emit the legacy shape whenever the draft has a non-empty `note` (or any case above), or every such
order fails on the box. Simplest app rule: run this formatter at prepare; on ANY refusal (`approval_card_invalid`
or `approval_card_not_minimal`) emit the legacy shape for that draft.

## The minimal-card budget (never cut a purchase)

approval-md 0.4.7 `telegram-minimal`: a quoted value is cut past `MINIMAL_QUOTE_MAX` = 280 code points, two
of which are the runtime's isolate marks, and some characters are drawn as `«U+XXXX»` marks. So each of the four
strings must be:

- 1 to 278 code points long (NOT 280: core draws a value inside two isolate marks and counts them, so a 279- or
  280-code-point value is already cut; the vectors pin 278 fits, 279/280/281 do not, and the core test proves the
  cut at 279 and 280 through approval-md 0.4.7); and
- made only of U+0020 spaces, letters, numbers, punctuation and symbols (Unicode general categories L, N, P, S)
  other than `«` U+00AB, `⏎` U+23CE, U+115F, U+1160, U+3164, U+FFA0, U+2800; and combining marks (category M)
  other than the default-ignorable U+034F, U+17B4, U+17B5, U+180B-U+180F, U+FE00-U+FE0F, U+E0100-U+E01EF, at
  most 2 in a row.

Otherwise the formatter refuses with `approval_card_not_minimal` and the app sends the legacy shape FOR THAT DRAFT
(prepare's payload, payload_hash and confirm all use the legacy shape; the box accepts it as today). The say entry
below quotes only the four keys, so core sends a legacy payload the technical card (fallback `unlisted-key`:
`appId`, `operation`, `preview` are not in the map): every line and price, never cut. A four-key payload that breaks the
budget is refused by the box. The rule is conservative: anything it refuses that core would have drawn whole
only costs a technical card.

## The card (the control plane's template; the overlay mirror follows it)

```yaml
        marketplace.app.action:
          does: "place an order with For Kicks for you"
          quote: { order: "Order", total: "Total", pickup: "Pickup", name: "Name shared with café" }
          note: none
```

Labels CONFIRMED (product + lead L17744). Core 0.4.7 refuses a label over 24 characters (`PROMPT_SAY_LABEL_MAX`,
`prompt-say-label`): the first wording "Name shared with the café" (25) would have failed the whole policy load;
"Name shared with café" is 21. The `does` phrase now names For Kicks for every card of the parent class; today For Kicks
is the only app that asks under it (a Gold Star send runs on its own member class; a legacy-shaped request of
any app gets the technical card, `unlisted-key`), so **approval-confirm** before a second app asks under it.
