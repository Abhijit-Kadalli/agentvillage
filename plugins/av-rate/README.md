# av-rate: the suggestion rating cards

Design: agentvillage-data `docs/design/suggestion-rating.md`. Replaces the evening outcome ask's
text question (overlay #198, "Did you and <name> meet? Reply met, not useful, or missed.") with up to
three Telegram button cards about the suggestion itself.

## What the resident sees

On the first evening run after an Index connection turns `accepted`, their own bot sends:

```
How good a match was this suggestion from Edge?
Maya Rao, about Climate finance

😕  Not a fit
😐  Weak fit
🙂  OK fit
😊  Good fit
🤩  Great fit

Maya Rao never sees this.
[ 😕 ] [ 😐 ] [ 🙂 ] [ 😊 ] [ 🤩 ]
```

The buttons carry one emoji each (values 1..5, `match_fit_5_v1` unchanged); five labelled buttons do
not fit a phone row, so the words are in the body. The privacy line promises only what the plugin
can keep whatever the resident's research consent (it cannot read consent): the counterpart never
sees the answer. Where the answer goes beyond the agent's own records is the consent brief's to say.
The card carries no DATA-373 manage line (product call, 2026-10-24); the resident still stops the
cards through the "Evening questions" job (below).

A tap answers "Recorded: Good fit", marks the button, and sends card 2:

```
Did you already plan this meetup?
[ Yes ] [ No ]
```

When card 1 was 3 or more, card 2's first tap sends card 3 (scale `connection_type_v1`):

```
What kind of connection is this?
We'll show you if it's mutual!
[ 🫂 Friend ] [ ❤️‍🔥 Spark ] [ 🤝 Collab ]
[        🤷 Not sure yet         ]
```

A fit of 1 or 2 ends at card 2. "We'll show you if it's mutual!" is a product promise; the mutual
reveal is not built yet (data docs/design/suggestion-rating.md).

Each card takes taps for 24 h from its own send; a re-tap with another value is a revision (last
wins downstream), the same value again answers "Already recorded" and records nothing. After card 3
(after card 2 when card 3 is not asked), or when every window has closed with card 1 answered, the
agent gets one line in the DM session:
`[Rating recorded] Maya Rao: 4/5 match fit; already planned: no; connection: spark. Reply with exactly: Got it!`
and replies "Got it!".

### The resident's controls

The cards go out under the "Evening questions" job and its manage line, so the resident's word
holds for them:

| Control | Trigger (stages) | Plugin (sends) |
|---|---|---|
| **Stop / manage** the evening job (Hermes's job record `cron/jobs.json`: `enabled: false`, `state: "paused"` or a `paused_at` on the job named "Edge — evening questions" whose id `av-events/installed_jobs.json` lists; message-labels.ts `storedJobEnabled`) | stages nothing (`rating-cards-job-stopped`) | defers every stage to the next pick-up (`deferred_job_stopped`), never drops |
| **Quiet hours**: the resident's evening window in `av-events/job-settings.json` (`jobs.evening.window` `HH:MM-HH:MM`, `tz`; job-settings.ts grammar), else 08:00 to 22:00 village time (`Asia/Kolkata`, the pending alert's default) | the evening job's own window gates the whole run (proactive.ts) | defers outside the window (`deferred_quiet_hours`); an invalid file or entry defers too (`deferred_settings_invalid`), never widens |
| **Team tenant** (`AV_TEAM_TENANT=1`, job-settings.ts `isTeamTenant`) | stages nothing (`rating-cards-team-tenant`) | drops the stages (`stage_dropped_team_tenant`) |
| **Stale stage** (older than 3 days, the trigger's STALE_DAYS) | — | drops it (`stage_dropped_stale`) |
| **Unreadable job store** | stages nothing (`rating-cards-jobs-unreadable`) | defers (`deferred_jobs_unreadable`) |

### The shared day budget

The agreed ceiling is three proactive messages per resident per day, all jobs together. The
trigger keeps no delivery ledger, only the once-a-day marks the other agent jobs write to
`memory/heartbeat-state.json` `proactiveRuns` when they wake the model (brief, drop-midday,
drop-evening, negotiation; the hourly pending alert has no day mark and is not counted). A mark
says the model was woken, not that it delivered: a run the model answered `[SILENT]` still carries
one. The rule counts every mark as a delivery (conservative, never over the ceiling):
`cardBudget = 3 − marks dated today`, less what this date already staged (a second run on one date
never exceeds the cap), and the evening stages at most that many card pairs
(`rating-cards:<n>:budget:<b>` in the run log when the budget cut it). The data side reads the real
count (`marts.proactive_messages_per_resident_day`, rule `proactive_ceiling_v2`).

### Sending and the ledger (review round 1)

- No lock is held across an `await`: every ledger change is one synchronous load-change-save, so a
  tap during a send keeps its answer.
- Write-ahead: the card is on the ledger before `send_message`; the message id is filled after;
  the stage is unlinked last. A pending card found later with no message id (a crash between send
  and save, or another process's) is kept as asked and never re-sent (`stage_resolved_pending`).
- A failed send withdraws the reservation; after 3 failed attempts across pick-ups the stage is
  dropped (`stage_dropped_send_failed`); a Telegram 429 waits its `retry_after`
  (`send_rate_limited`, then `deferred_rate_limited`).
- A tap must come from the card's own chat and message (card 1's, 2's or 3's id); a tap with no
  message is refused as not the owner's.
- Evicted cards (over 500) leave id-only tombstones in `evicted`, so they stay asked.
- The injected line is retried up to 3 times when Hermes refuses or errors (it returns one
  boolean for "flag off", "no live gateway" and "scheduling failed"), then `inject_gave_up`.

## How it works

| Step | Where | What |
|---|---|---|
| Pick the subjects | `skills/index-network/scripts/rating-cards.ts` via `proactive.ts` (the `evening` action, 19:00 IST) | every connection Index lists `accepted`, not on the plugin's ledger, first seen within 3 village days, oldest first, at most 3 per evening; one stage file per subject in `av-events/proactive/rating/` (0600; the cleaned name and headline are the only text) |
| Send card 1 | this plugin, `pick_up`, every 60 s on the gateway loop (PTB job queue when installed, else an asyncio task) | `AV_RATE_CARDS` on: reads the stages, sends to the home chat, records the card on `av-events/proactive/rated.json`, hands `opportunity.rating_asked` over |
| Taps | `CallbackQueryHandler` on `^avr:` (`block=False`) | owner only (av-vote's rule), inside the window, revisions; marks the button; first fit tap sends card 2, first planned tap sends card 3 when the fit is 3 or more; hands `opportunity.rated` / `opportunity.pre_planned` / `opportunity.connection_typed` over |
| Events | `plugins/av-events/_rating_cards.py`, on the flusher's cron-tail cadence | reads `av-events/proactive/rating-events/*.json`, emits with ids derived from (type, opportunity, card, revision), consumes the files |
| The agent | `ctx.inject_message` | gated by `plugins.entries.av-rate.allow_gateway_injection: true` (the installer writes it) |

`callback_data`: `avr:f:<1-5>:<nonce>`, `avr:p:<y|n>:<nonce>` and `avr:t:<f|s|c|u>:<nonce>`, under 64 bytes. The nonce is 22
base64url characters of HMAC-SHA256(key, `avr|<opportunity_id>|match_fit_5_v1`) under the tenant's
av-events key (`av-events/hash.key`), else this plugin's own `av-events/av-rate.key`.

### Events (built by av-events from the hand-off records; the plugin never posts)

| Type | Payload | Envelope | Actor |
|---|---|---|---|
| `opportunity.rating_asked@1` | `question_version` `match_fit_5_v1` (`connection_type_v1` for card 3), `card` `fit`/`planned`/`type`, `message_hash` (the card text's keyed hash), `window_hours` 24 | `opportunity_id`, `intention_id` (null unless the stage named one) | `system` |
| `opportunity.rated@1` | `value` 1..5, `scale` `match_fit_5_v1`, `channel` `telegram_button`, `revision`, `rated_at` | same | `participant`, `self_report` |
| `opportunity.pre_planned@1` | `value` `yes`/`no`, `channel`, `revision`, `answered_at` | same | `participant`, `self_report` |
| `opportunity.connection_typed@1` | `value` `friend`/`spark`/`collab`/`unsure`, `scale` `connection_type_v1`, `channel`, `revision`, `answered_at` | same | `participant`, `self_report` |

### Assumptions built in (the design note's open items, defaults taken)

- Labels: Not a fit / Weak fit / OK fit / Good fit / Great fit, pinned as `match_fit_5_v1`.
- Each card's window is 24 h from its own send; later taps answer "This question has closed." and record nothing.
- An acceptance rolled over by the cap expires unasked after 3 village days.
- The cap is the shared day budget above (day marks counted as deliveries).
- The agent answers the injected line with "Got it!" only (the line says so; `tools.md` too).
- The cards reuse the "Evening questions" stop/manage toggle and honour it (above); they carry no manage line.
- The counterpart's cleaned name and Index's cleaned headline appear on the card.
- The old text ask stays in the tree behind `AV_OUTCOME_TEXT_ASK` (default off) for one release.
- The cleaned name is kept on the ledger (a 0600 file in the home) for the injected line.

### Switches and files

| | |
|---|---|
| `AV_RATE_CARDS` | `1|true|yes|on` sends cards (process environment, else `$HERMES_HOME/.env`). Default off: stages are left in place, taps still answer. |
| `AV_RATE_SESSION_KEY` | overrides the injection target (default `agent:main:telegram:dm:<home chat id>`) |
| `AV_OUTCOME_TEXT_ASK` | av-events: the old text ask's arming, answers and pass (default off) |
| `av-events/proactive/rating/stage-<id>.json` | the trigger's stage, consumed by the pick-up (deferred, not dropped, while the job is stopped or in quiet hours) |
| `av-events/proactive/rated.json` | the ledger: nonce, chat and message ids, both windows, both answers, the name, injection attempts; `evicted` id tombstones |
| `cron/jobs.json`, `av-events/installed_jobs.json`, `av-events/job-settings.json` | read for the resident's controls, exactly as the trigger reads them |
| `av-events/proactive/rating-events/*.json` | hand-off records for av-events, consumed on its tick |

Logs: `av-rate: tenant=<id8> outcome=<code> [k=v ...]`; never a name, token, user id or callback
data.

## Local test with your own bot

You need Hermes at `~/.hermes` with a Telegram bot token (`TELEGRAM_BOT_TOKEN` in `~/.hermes/.env`),
your own Telegram account paired as the bot's owner (the home channel after `/sethome`, or
`TELEGRAM_HOME_CHANNEL=<your user id>` in `.env`), `bun`, and a checkout of this repo.

1. Stage the two plugins into your Hermes home and enable them:

   ```bash
   mkdir -p ~/.hermes/plugins
   cp -R plugins/av-events plugins/av-rate ~/.hermes/plugins/
   ```

   In `~/.hermes/config.yaml`:

   ```yaml
   plugins:
     enabled: [av-events, av-rate]
     entries:
       av-rate:
         allow_gateway_injection: true
   ```

   (The installer does this on a box: `install/av_rate.ts`.)

2. In `~/.hermes/.env` add:

   ```
   TELEGRAM_BOT_TOKEN=123456789:AAF...            # from @BotFather, /newbot
   TELEGRAM_HOME_CHANNEL=123456789                 # your numeric Telegram user id (@userinfobot)
   TELEGRAM_ALLOWED_USERS=123456789                # same id: skips the DM pairing step
   AV_RATE_CARDS=1
   AV_TENANT_ID=0190a5b2-0000-4000-8000-00000000c0de   # any UUID; av-events requires the UUID shape
   AV_EVENTS_TOKEN=local-null-sink                 # any non-empty value, see below
   ```

   av-events idles entirely when `AV_EVENTS_TOKEN` is unset: no hooks run, no buffer, and the
   rating hand-off files are never picked up. A token with `AV_EVENTS_URL` unset is av-events'
   **null-sink mode**: events are written to its local buffer and never posted, which is what you
   want for a first tap test. Set `AV_EVENTS_URL` (and a real token) to a local ingest
   (`agentvillage-data`, `docker compose up`, `bun run src/ingest/server.ts`) to see them land in
   `events.events` instead.

3. Start the gateway and watch its log:

   ```bash
   hermes gateway 2>&1 | grep -E "av-rate|av-events: rating"
   ```

   Expect `av-rate: rating card buttons wired (pattern ^avr:)` and
   `av-rate: pick-up on the job queue every 60s` (or `on a loop task`).

4. Stage one card by hand (no Index call, no state change), from the repo checkout:

   ```bash
   HERMES_HOME=~/.hermes bun skills/index-network/scripts/rating-cards.ts --stage-test \
     --opportunity 0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d --name Maya --headline "Climate finance"
   ```

5. Within about 60 s card 1 arrives in your DM with the bot. The log shows
   `av-rate: tenant=local-te outcome=pickup sent=1`. Tap an emoji: the toast says `Recorded: ...`,
   the button gets a check mark, card 2 arrives (`outcome=recorded`, `outcome=planned_sent`). Tap
   Yes or No: card 3 arrives when you tapped 🙂 or better (`outcome=type_sent`); tap a type:
   `outcome=injected` and the bot answers "Got it!" to
   `[Rating recorded] Maya: 4/5 match fit; already planned: no; connection: spark. ...` (with 😕 or 😐
   the line goes out on the Yes/No tap instead; with the gate off you see
   `outcome=inject_refused` and Hermes's own warning naming `allow_gateway_injection`).

6. Check the files and events:

   ```bash
   cat ~/.hermes/av-events/proactive/rated.json | python3 -m json.tool
   ls ~/.hermes/av-events/proactive/rating-events/        # emptied by av-events within a minute
   grep -h '"opportunity\.\(rating_asked\|rated\|pre_planned\|connection_typed\)"' ~/.hermes/av-events/buffer* 2>/dev/null | head
   ```

   With a local ingest: `select event_type, actor, payload from events.events where event_type like 'opportunity.rat%' or event_type in ('opportunity.pre_planned', 'opportunity.connection_typed') order by occurred_at;`

To test the trigger itself instead of `--stage-test`, run the evening action with the plugin's seams
in `skills/index-network/scripts/tests/rating-cards.test.ts`, or on a box with an Index key:
`hermes cron run <id of "Edge — evening questions">`.

## Tests

```bash
python -m pytest plugins/av-rate plugins/av-events/tests/test_rating_cards.py -q
bun test skills/index-network/scripts/tests/rating-cards.test.ts install/tests/av_rate.test.ts install/tests/proactive_jobs.test.ts
```
