# GODCONST authors round: the ballot as Telegram cards (GC-TELEGRAM-BALLOT)

Status: built dark on three branches, nothing deployed. Branch `feat/godconst-telegram-ballot` in the overlay
(this repo), the app and the control plane. The data repo is unchanged; its part is a proposal (section 5).
The app branch is stacked on `feat/godconst-ballot-channel` (migration 0110, `channel` web|telegram, `opts.channel`),
which must merge first; the order rule depends on `feat/godconst-author-sample` (section 9).

## 1. What the resident gets

The lead's decision: the authors-round ballot (30 statements, 15 by residents' agents, 15 by ODIN, rated blind) is
also delivered by each resident's **own** Telegram bot as button cards. It comes in **pairs**: one agent-written and
one ODIN-written statement, in a random inside order per resident. The next pair arrives once the current one is
rated, so the ballot feels short. A tap is a rating saved on the **same** ballot that `/constitution` shows. The page and the
cards coexist: a change on either shows on the other, and the last write wins per statement. A re-tap is a revision.
The window is the pool's rating window (24 h). "Rate as many as you can": an unrated statement means no opinion.

```
Village constitution: 30 statements to rate

Tap one button per statement, from 1 to 5. Rate as many as you can: an unrated statement counts
as no opinion. Tap again to change a rating. You won't see who wrote each statement.

1  Strongly oppose inclusion
...
5  Strongly support inclusion

You'll get 2 statements at a time; the next ones arrive once you've rated these. Each tap is saved
on your ballot straight away, the same ballot as on the Constitution page. When you're done, press
Submit my ratings: you can submit with some statements unrated.

Open until 10:30 IST, Sun 25 Oct.

Private: only you and the research team see your ratings. Your agent does not see these cards.
[ Submit my ratings ] [ Stop these cards ]
```

```
Statement 3 of 30 · Care and wellbeing

<statement text>

1 strongly oppose inclusion · 3 neutral · 5 strongly support inclusion
[ 1 ] [ 2 ] [ 3 ] [ 4 ] [ 5 ]
[ Submit my ratings ]          (second row, on the last card of each page only)
```

A tap answers `Saved: Support inclusion` (`(changed)` on a revision) and puts a check on the button. The texts and
the tap behaviour are those of the lead's local preview (`~/.hermes/plugins/av-godconst-preview`). Its "authors
round" heading is dropped, because a heading that names authorship invites guessing. Labels are `contracts.ts`
`RATING_LABELS`, exactly. When every statement is rated, one line follows:
`All 30 statements rated. Thank you. Press Submit my ratings to make them final, ...` with `[Submit my ratings]`.
If the resident skipped some, the line reads `That's every statement. You rated 24 of 30; the others count as no
opinion. ...`. Submit always asks first (`Submit your ratings now? You rated X of N ... final` with `[Yes, submit]
[Not yet]`); Yes answers `Submitted` and every later tap answers `Your ballot is submitted, so rating is closed for you.`

## 2. The data path

```
 resident's bot (Telegram)           box (Hermes + av-godconst)             control plane                     app
 ───────────────────────────         ────────────────────────────           ─────────────                     ───
 cards  <── sendMessage ───────────  pass every 60 s:                       POST /tenants/:id/godconst/ballot
                                     read at most every 5 min (open)  ───>  Bearer <box EDGEOS_API_KEY>  ───>  POST /api/v1/constitution/telegram-ballot
                                     or 10 min (idle)                       checkTenantEdgeosKey               Bearer REFERENDUM_RUNTIME_BRIDGE_KEY
 tap gcb:r:<nonce>:<pos>:<v>  ─────> owner check, nonce check               GODCONST_BALLOT_TENANTS            {tenant_id} (the AUTHENTICATED tenant)
                                     POST .../godconst/ballot/rate   ───>   research consent in force   ───>  POST .../telegram-ballot/rate
                                                                            forward, pass the answer back      {tenant_id, pool_sha256, statement_id, rating}
```

**Who authenticates as whom.**
- The box never holds an app credential. It calls its own control plane with its own `EDGEOS_API_KEY`. This is the
  ask-village wire (`plugins/av-events/_ask_village.py`): `CONTROL_PLANE_URL` is pinned to `CP_HOSTS`, with no
  redirects and no proxy.
- The control plane verifies that key against the path's tenant (`edgeos-directory.js checkTenantEdgeosKey`). It
  forwards with B7's GODCONST bridge key (`REFERENDUM_RUNTIME_BRIDGE_KEY`), the key B7 already uses in both
  directions, so there is no new secret. It adds `tenant_id`, which is the authenticated tenant; a `tenant_id` in the
  box's body is refused.
- The app trusts the bridge for one fact only: which cp tenant is asking. From that tenant it finds the one
  `agent_setups` row (none or several: 404) and applies the page's own rules:
  - `godconstAdmits`: `GODCONST_COHORT`, or the join code;
  - `requireTakePart`: any accepted research consent, not withdrawn, none pending;
  - the current pool's phase, the resident's participant row, their order (`residentOrder`) and their latest revision.

**No other resident's data can reach a box.**
- The read answers exactly what `currentBallot` shows that resident on the page: the pool's statements (the same for
  everyone), in that resident's order, with their own ratings.
- It never carries authorship (`author_type` is never selected into the answer), another participant's anything, or
  the participant id.
- The box cannot name another tenant: the path tenant must match its own key.

**The grant and consent re-check before every send and every tap.**
- Every card send comes from a fresh read (the texts are never stored, so a send without a read is impossible).
- Every tap is a save.
- Both go through three layers:
  1. the control plane re-reads research consent (`consent.researchConsentInForce`, B7's rule) and the tenant list;
  2. the app re-reads admission and take-part consent (read: `residentByCpTenant`; save: also `lockResident`
     *inside* the save's transaction, the page's TOCTOU guard);
  3. the database's 0070/0079 guard (pool rating, current hash, not submitted, the withdrawal fence).
- A withdrawal mid-window therefore refuses the very next tap. Pages already sent stay in the chat, but cannot save.

**What the box keeps (nothing private), and when it forgets.**
- `$HERMES_HOME/av-godconst/ballot.json` (0600 in a 0700 directory) holds:
  - the pool id and hash;
  - the order's statement ids;
  - a session nonce;
  - the Telegram message id of each card;
  - which positions are rated.
- No rating value, and no keyed mark or hash of one (a 5-value domain is recoverable from any such tag): what a
  card's check shows is held in memory only (`_SHOWN`); after a restart every sent card is redrawn from the app's
  value. There is no key file.
- Statement texts and rating values exist on the box only in memory, between the read and the send, or between the
  tap and the save.
- When the ballot ends on the box (submitted, the owner's Close, the rating window over, or a withdrawal: the app's
  403 / 404 or the control plane's `research_consent_required`), the session is deleted and only a tombstone stays:
  `{pool_sha256, nonce, status, at}`. A later tap on an old card answers why it no longer saves; the pool is never
  restarted on that box.

**The agent stays blind.**
- Nothing is injected into the agent's session.
- The Bot API's own sends are not updates.
- The `^gcb:` handler answers every tap before Hermes's core sees it.
- The B3 snapshot never reads `av-godconst/`; it reads `godconst-capture.py`'s fixed paths, `knowledge/` and
  `state.db`.

So the status-quo snapshot (S1), the agent runs and B7's elicitation (S2) cannot learn the resident's ratings from
this channel. That is the reason for the departure from av-rate, which does inject one line.

## 3. The delivery rule

| | |
|---|---|
| Order | The POOL's rule, never a hard-coded one (`telegram-order.ts`): the stored `godconst_pools.rating_order_rule` when present, else the rule Open pins (v2 for a pool with two author arms). Under `godconst-order-v2`, positions (2k, 2k+1) are one agent-written and one ODIN-written statement, with the inside order random per resident. The box never sees authorship and does not need to. |
| Page | `PAIRS_PER_PAGE = 1`, so `PAGE_SIZE = 2` (`plugins/av-godconst/_logic.py`). One constant. |
| Start | On the first read that finds the pool `open` for this resident (rating, a participant, not submitted), the header and then the first page go out. The first send happens only between 08:00 and 21:30 IST (B7's opener window) and only before `rating_closes_at`. If every statement is already rated on the web, nothing is sent. |
| Next page | Sent when every statement of the current page is rated (by a tap, or on the web page, seen on the next read). A page whose statements were all rated on the web is skipped. A statement already rated on the web gets no card. |
| End | Once there is no further page and the current one is rated: one final line (all rated, or "you rated X of N"). The session is then `done`. A later tap still saves. |
| Revisions | A re-tap on any card saves again (`Saved: ... (changed)`). A change on the web page moves the check on that card at the next read (at most 10 re-marks per pass). |
| Window | At `rating_closes_at` the box ends the session (tombstone) and answers later taps "Rating has closed." without calling out. The web page keeps working until the owner's Close (`GC-ASYNC-WINDOW`). |
| Close | The owner's Close (rating to closed) makes the app refuse every tap (`409 pool_not_rating`): "Rating has closed." That refusal, or the next read, ends the session. No message is sent at close (open question 3). |
| Submit | `[Submit my ratings]` on the header, on the last card of each page and on the final line. It asks to confirm, then `POST .../ballot/submit {pool_sha256}`: the app's `submitBallotFor` WITHOUT ratings, so the submitted ballot is the server's latest merged draft (page and Telegram), channel `telegram`, partial allowed (at least one rating, else "Rate at least one statement before you submit."). Telegram-only raters thus reach the submitted electorate (the primary analysis), not only `draft_ballots`. B7's after-submit hook runs as for the page. Submitting on the web page ends the cards the same way (`409 submitted` on the next tap or read). |
| Stop / opt-out | `[Stop these cards]` on the header: no more pages, taps still save, one line confirms, and the button becomes `[Resume these cards]`. Owner level: `GODCONST_BALLOT_TENANTS=none` (no new cards anywhere), or the app flag off (every tap then answers "Rating by Telegram is off right now..."). |
| Taps | Owner only: the box's own resident in their own DM (av-vote's rule: the home channel's ids, `TELEGRAM_HOME_CHANNEL`, Hermes's approved pairings; private chat, `chat == user`). A card from an earlier pool (another nonce) answers "This card is from an earlier ballot." |

The box reads at most every 5 minutes while its ballot is open, and every 10 minutes otherwise, so the first cards
reach a resident at most about 10 minutes after Open. A tap that completes a page reads once more, to get the next
texts.

## 4. The write path

`tap -> POST /tenants/:id/godconst/ballot/rate {pool_sha256, statement_id, rating}` -> the app
`telegramBallotRate` -> `service.ts saveDraftFor(resident, BY_SETUP(setup), {poolSha256, ratings: {id: v},
changed: [id]}, "telegram")`.

- **One transaction, the page's own:**
  1. `lockResident` (the setup FOR SHARE, cohort and consent re-checked);
  2. `ratingPoolFor` (the rating pool FOR SHARE at the hash the card was built from: a stale card is
     `409 stale_pool`);
  3. `joinLocked` (the participant row FOR UPDATE, which serialises the tap with any page save of the same resident);
  4. the latest revision;
  5. the merge;
  6. one new append-only revision (`kind` draft, `channel` `telegram`, migration 0110).
- **Idempotency:** a tap that changes nothing (a double tap, or a retry of a save that landed) writes nothing and
  answers `unchanged: true`. Taps on one card are also serialised on the box (`Still saving...`). The box never
  retries a save by itself: a failure says "Could not save that. Tap again...".
- **Concurrency with the web page.** The page used to save its full local set (`PUT /ballot {poolSha256,
  ratings}`), so a page left open would have erased a Telegram tap made meanwhile. Two changes fix this:
  - `SaveBallot` now takes an optional `changed: [ids]`. The page sends the ids touched since its last save that
    landed, and the server applies only those onto the latest revision (an id with no value clears it).
  - The page adopts the server's merged ballot from every save reply, for every statement it has not changed since,
    so Telegram's ratings show on the page.

  The result is last write wins **per statement**, in both directions. One window remains: a tap made after the page
  opened its review and before the resident pressed Submit is not in the submit body (the page submits its own set).
  It is documented; closing it means submitting without `ratings` after a flush (open question 6).
- **Answers:** `{state: "saved", unchanged, revision, ratings, progress}`. Refusals are `{error: code}`:
  - `409`: `stale_pool`, `pool_not_rating`, `submitted`;
  - `422`: `bad_rating`;
  - `404`: not admitted;
  - `403`: `consent_withdrawn`, `research_grant_required`.

  The control plane passes them through. Its own codes are `401 unauthorized`, `403 not_enabled`,
  `403 research_consent_required`, `429 rate_limited` (30 per minute per tenant) and `busy`, `502` / `504`.

## 5. Events

**Existing door events that fire, unchanged:**
- `godconst.ballot_saved@1` fires once per tap that writes a revision. It goes through the same builder as the page's
  save (`events.ts noteBallotSavedFor`, keyed by the setup instead of the session) and carries `pool_id`,
  `participant_ref`, `revision`, `n_rated`, `n_statements`, `pool_sha256` and `saved_at`. It has no channel and no
  value.
- A tap that writes nothing fires nothing.
- `godconst.ballot_submitted@1` fires on a Telegram submit through the same builder (`noteBallotSubmittedFor`).
- `pool_frozen@1` and `pool_closed@1` are unchanged.
- No text or value field is added anywhere.

**The box emits no event**: no hand-off to av-events, because the data door has no type for it and the data repo is
not changed here.

**Proposals for the data repo (not built):**
1. `godconst.ballot_saved@2` / `ballot_submitted@2`: `@1` plus `channel` (`web` | `telegram`), from the revision's
   column (feat/godconst-ballot-channel's 0110). The owner export already carries `channel` and `saves[]` on that
   branch; the event field would let the door separate a mode effect too.
2. `godconst.telegram_ballot_delivered@1` (R, actor `system`, from the box through av-events' hand-off files, as
   av-rate's `opportunity.rating_asked`): `pool_id`, `page` (0-based), `n_cards`, `order_rule`, `sent_at`, plus a
   keyed `message_hash` per card. Ids and counts only. It measures exposure (who was shown which pair, when), which
   the app cannot see. Until it exists, exposure is inferred from `ballot_saved` timing.
3. `godconst.telegram_ballot_settled@1` (R): `outcome` (`done` | `stopped` | `submitted` | `closed` | `withdrawn` |
   `undeliverable`), `n_pages_sent`, `n_rated_at_settle`, `settled_at`. Like B7's outcome codes, it reports
   non-response.

## 6. Failure modes

| Failure | What happens |
|---|---|
| Box offline, gateway restarting | No pass, no taps answered (Telegram shows the spinner, then nothing). Nothing is lost: the ballot lives in the app. On restart the next pass reads and goes on from the ledger. The page always works. |
| Bot blocked or chat gone | `sendMessage` fails. The page is retried on the next passes, and after 3 failed passes in a row the session is `undeliverable` and nothing more is sent. |
| Control plane or app down, timeout | Read: the pass logs a code and tries at the next poll. Tap: "Could not save that. Tap again, or use the Constitution page." The card is unchanged, and nothing is saved twice (the merge is idempotent). |
| The app's route off (flag unset) | The control plane maps the app's 404 to `502 upstream_unavailable`; the box answers "Could not save...". With the cp flag off, the route is the plain 404 and the box answers "Rating by Telegram is off right now...". |
| Withdrawal mid-window | The control plane (`research_consent_required`) or the app (`consent_withdrawn`) refuses the next read or tap. The box settles `withdrawn` and sends nothing more. The app's withdrawal scrub deletes the revisions as before. The cards already in the chat stay, holding text only; the box keeps no value. |
| Pool closed or re-seeded meanwhile | `409 pool_not_rating` / `stale_pool` on the tap ("Rating has closed."). The read settles `closed`. A new pool gets a new session (new nonce), and old cards answer "from an earlier ballot". |
| Ledger unreadable or tampered with (not 0600, foreign owner, bad JSON) | Nothing is sent or overwritten. Taps answer "from an earlier ballot". Logged `ledger_<code>`. |
| The app's 404 on a save (no longer admitted) | Treated as a withdrawal: tombstone, "You can't take part right now." The control plane's own `403 not_enabled` (a switch) is not an ending. |
| Two taps at once, a tap racing a pass | Taps on one card are refused while one is saving. Page sends hold one asyncio lock and re-read the ledger, so a page is sent once. |
| The app's order differs from the session's (it never should) | Logged `order_changed`; nothing sent. |

## 7. What changes in each repo

**App** (`feat/godconst-telegram-ballot`, from origin/main)
- Stacked on `feat/godconst-ballot-channel` (its migration 0110 and `SaveOptions.channel`; this branch adds no
  migration).
- `src/lib/server/godconst/telegram-ballot.ts` (new): the flag (`GODCONST_TELEGRAM_BALLOT=1` plus `GODCONST_COHORT`
  plus the bridge key), `residentByCpTenant`, `telegramBallotView`, `telegramBallotRate`, `telegramBallotSubmit`, the
  log line (op, tenant id8, code).
- `src/lib/server/godconst/telegram-order.ts` (new): the pool's order rule; a COPY of `participantOrderInterleaved`
  (DEPENDENCY note).
- `src/lib/server/godconst/telegram-ballot-route.ts` (new): B7's route order (404 when off, bearer before body,
  2 KB strict body, `{error: code}`).
- `src/app/api/v1/constitution/telegram-ballot/route.ts`, `.../rate/route.ts`, `.../submit/route.ts` (new): POST only.
- `src/lib/server/godconst/service.ts`: `saveDraft` -> `saveDraftFor(resident, setupSelector, body, channel)` and
  `submitBallot` -> `submitBallotFor(...)`; per-statement merge with `changed`; no-op taps write nothing; a few
  readers exported.
- `src/lib/server/godconst/events.ts`: `noteBallotSavedFor`, `noteBallotSubmittedFor` (same payloads).
- `src/lib/godconst/contracts.ts`: `SaveBallot.changed` (optional).
- `src/components/constitution/RatingBallot.tsx`: sends `changed`, adopts the merged ballot.
- `.env.example`: `GODCONST_TELEGRAM_BALLOT`.
- Tests: `telegram-ballot.db.test.ts` (7, real Postgres), `telegram-ballot-routes.test.ts` (12), `RatingBallot.test.tsx`
  (+1, 4 updated).

**Control plane** (`feat/godconst-telegram-ballot`, from origin/main)
- `control-plane/src/godconst-ballot.js` (new): the three forwards, read / rate / submit (box key, tenant list,
  research consent, strict body, limits, pass-through). Log line: `godconst_ballot op tenant=<id8> status code
  app_status ms`, never a body or a full id.
- `control-plane/src/index.js`: the three routes, dispatched before the API-key gate, as ask-village is.
- `control-plane/src/box-event-flags.js`: `AV_GODCONST_BALLOT` by `GODCONST_BALLOT_TENANTS`, only while
  `GODCONST_BALLOT_ENABLED=1` (as `AV_PRAY`).
- `docs/RAILWAY.md`: the two variables.
- Tests: `tests/godconst-ballot.test.js` (9), `tests/box-event-flags.test.js` (+1, the shared cases).

There is no trigger and no worker: the box pulls. A push (the app or the control plane staging the ballot onto boxes
at Open) would need an exec per box and would put statement text on disk. The pull needs neither, and the box's next
read is within 10 minutes.

**Overlay** (this branch)
- `plugins/av-godconst/` (new): `__init__.py` (wiring, pass, sync, taps, submit, the control-plane client, the
  ledger and tombstone, the page-open marker), `_logic.py` (pages, texts, callback data, the read's shape),
  `plugin.yaml`, `tests/` (24).
- `install/av_godconst.ts` + `install/install.ts`: residents list `av-godconst` in `plugins.enabled`.
- `install/profile.ts`: ODIN boxes never do.
- `plugins/av-approval/expected_plugins.json`: `av-godconst` in the expected set (new `expected_set_version`); its
  inventory test counts 10 expected plugins.
- `pytest.ini`: the test path.

**Data**: nothing changed. Proposals are in section 5.

## 7a. Coexistence with elicitation (B7 / GC-ELICIT)

While a sent page has an unrated card, the cards are active and the window is open, the plugin keeps an empty marker
file `$HERMES_HOME/av-events/godconst/page-open` (0600, in a 0700 directory, no content). It is removed:
- when the page is complete;
- on Stop;
- on submit;
- at window close or the owner's Close;
- on withdrawal (the app's 403 / 404).

Each page sent touches the marker (refreshes its mtime). At plugin start it is reconciled with the ledger and removed
unless a sent page has unrated cards inside an open window, so a crash or a restart never leaves it stale. The
av-elicit plugin (GC-ELICIT, overlay PR #478) ignores a marker older than 12 h, and otherwise holds its opener while the file exists, so the agent's invitation to
talk never lands in the middle of a pair. B7's control-plane path (the opener after a submit) is unaffected: a
Telegram submit runs the same after-submit hook as the page's.

## 8. The owner's runbook

The press order (each step is a human Railway variable edit or an owner press; every step is reversible):

1. **Deploy dark.** Merge `feat/godconst-ballot-channel` (migration 0110), then the three branches. The new variables are unset, so both
   app routes and both cp routes are 404, no box has `AV_GODCONST_BALLOT`, and the plugin idles.
2. **Roll the overlay** to the release that holds `av-godconst`. The installer enables it on resident boxes; it
   idles without the line.
3. **App:** set `GODCONST_TELEGRAM_BALLOT=1`. `GODCONST_COHORT` and `REFERENDUM_RUNTIME_BRIDGE_KEY` are already set
   for B7 and B3.
4. **Control plane:** set `GODCONST_BALLOT_ENABLED=1` and `GODCONST_BALLOT_TENANTS=<Carter's tenant id>` (then
   rewire that tenant, so its `.env` gets `AV_GODCONST_BALLOT=1`). `VILLAGE_BRIDGE_ORIGIN` already points at the app.
5. **Check the order rule on Carter's box.** The plugin logs `outcome=order n=30 rule=godconst-order-v2` when it
   starts. If it says `godconst-order-v1`, the pairing dependency (section 9) is not deployed: stop here.
6. **Rehearse** with Carter's tenant on a test pool. Open rating in `/admin/constitution`; within about 10 minutes the
   header and the first pair arrive (between 08:00 and 21:30 IST). Rate, re-tap, change one on the page, watch the
   check move, Stop and Resume, then Close. In the app, `godconst_ballot_revisions.channel` shows `telegram` rows.
7. **Widen:** `GODCONST_BALLOT_TENANTS=all` (or the cohort's ids), then roll or rewire.
8. **Round day:** open rating in the morning (IST), so first cards go out the same day. Close as usual; the cards
   need nothing at Close.

To stop:
- `GODCONST_BALLOT_TENANTS=none` and a rewire: no new cards on any box. Taps on cards already sent are then refused
  `not_enabled` ("Rating by Telegram is off right now...").
- `GODCONST_BALLOT_ENABLED` unset: the cp routes are 404 at once.
- `GODCONST_TELEGRAM_BALLOT` unset: the app routes are 404 at once.
- The web page is never affected.

## 9. Dependency on the uncommitted authors branch

The pairing guarantee comes from the order rule. On origin/main the page's `residentOrder` is `godconst-order-v1`.
`godconst-order-v2` (`participantOrderInterleaved`) and the pool's pinned rule (`godconst_pools.rating_order_rule`,
migration 0111, set at Open) live on the uncommitted app branch `feat/godconst-author-sample` (worktree
`.claude/worktrees/godconst-authors`). The cards never hard-code a rule: they follow the stored rule, else the rule
Open would pin.

Until then, `telegram-order.ts` reads the stored rule through `to_jsonb` (so it works before migration 0111) and
holds a copy of `participantOrderInterleaved` with a DEPENDENCY note. On main without that branch, the page shows the
v1 order while the cards follow v2. Only the order differs; the ballot is the same. After the merge, delete the copy
and call `residentOrder`, so both surfaces share one code path.

## 10. Open questions for the lead (defaults taken)

1. **Submit on Telegram** (coordinator review: built). Default placement: the header, the last card of each page and
   the final line, always behind a confirmation. Alternative: only after the last page.
2. **Reminders?** Default: none. The first page arrives once and later pages follow taps. Alternative: one reminder
   at `rating_closes_at - 6 h` if the current pair is unrated. It would count toward the proactive-message ceilings,
   unlike cards that follow a tap.
3. **A message at Close?** Default: none. The session settles silently, and late taps answer "Rating has closed."
4. **First-send hours.** Default: 08:00 to 21:30 IST (B7's opener window). A pool opened at night starts its cards
   at 08:00.
5. **Channel in the door events.** The export carries it (feat/godconst-ballot-channel). Default: no event field.
   Alternative: proposal 5.1.
6. **The submit race on the page** (a Telegram tap after the page opened its review). Default: accepted and
   documented. Alternative: the page submits without `ratings` after a flush, so the server uses its merged draft.
7. **Header wording**: "Your agent does not see these cards" is true of this channel. Default: keep it; it answers
   the question residents will ask. Drop it if the lead prefers not to raise the agent at all.
8. **Page size.** Default: one pair per page (`PAIRS_PER_PAGE = 1`). Two pairs per page halves the number of round
   trips but doubles what is on screen.
