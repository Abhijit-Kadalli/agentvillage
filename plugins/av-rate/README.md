# av-rate: the suggestion rating cards

Design: agentvillage-data `docs/design/suggestion-rating.md`. Replaces the evening outcome ask's
text question (overlay #198, "Did you and <name> meet? Reply met, not useful, or missed.") with two
Telegram button cards about the suggestion itself.

## What the resident sees

On the first evening run after an Index connection turns `accepted`, their own bot sends:

```
How good a match was this suggestion from Edge?
Maya Rao, about Climate finance

1  Not a fit
2  Weak fit
3  OK fit
4  Good fit
5  Great fit

Private: only you and the research team see this. Maya Rao does not.

(Evening questions message - you can ask me to stop or manage it)
[ 1 ] [ 2 ] [ 3 ] [ 4 ] [ 5 ]
```

A tap answers "Recorded: Good fit", marks the button, and sends card 2:

```
Did you already plan this meetup?
[ Yes ] [ No ]
```

Taps are accepted for 24 h; a re-tap is a revision (last wins downstream). After card 2, or when the
window closes with card 1 answered, the agent gets one line in the DM session:
`[Rating recorded] Maya Rao: 4/5 match fit; already planned: no.` and the skill tells it to store
it and reply with at most one short line.

## How it works

| Step | Where | What |
|---|---|---|
| Pick the subjects | `skills/index-network/scripts/rating-cards.ts` via `proactive.ts` (the `evening` action, 19:00 IST) | every connection Index lists `accepted`, not on the plugin's ledger, first seen within 3 village days, oldest first, at most 3 per evening; one stage file per subject in `av-events/proactive/rating/` (0600; the cleaned name and headline are the only text) |
| Send card 1 | this plugin, `pick_up`, every 60 s on the gateway loop (PTB job queue when installed, else an asyncio task) | `AV_RATE_CARDS` on: reads the stages, sends to the home chat, records the card on `av-events/proactive/rated.json`, hands `opportunity.rating_asked` over |
| Taps | `CallbackQueryHandler` on `^avr:` (`block=False`) | owner only (av-vote's rule), inside the window, revisions; marks the button; first fit tap sends card 2; hands `opportunity.rated` / `opportunity.pre_planned` over |
| Events | `plugins/av-events/_rating_cards.py`, on the flusher's cron-tail cadence | reads `av-events/proactive/rating-events/*.json`, emits with ids derived from (type, opportunity, card, revision), consumes the files |
| The agent | `ctx.inject_message` | gated by `plugins.entries.av-rate.allow_gateway_injection: true` (the installer writes it) |

`callback_data`: `avr:f:<1-5>:<nonce>` and `avr:p:<y|n>:<nonce>`, under 64 bytes. The nonce is 22
base64url characters of HMAC-SHA256(key, `avr|<opportunity_id>|match_fit_5_v1`) under the tenant's
av-events key (`av-events/hash.key`), else this plugin's own `av-events/av-rate.key`.

### Events (built by av-events from the hand-off records; the plugin never posts)

| Type | Payload | Envelope | Actor |
|---|---|---|---|
| `opportunity.rating_asked@1` | `question_version` `match_fit_5_v1`, `card` `fit`/`planned`, `message_hash` (the card text's keyed hash), `window_hours` 24 | `opportunity_id`, `intention_id` (null unless the stage named one) | `system` |
| `opportunity.rated@1` | `value` 1..5, `scale` `match_fit_5_v1`, `channel` `telegram_button`, `revision`, `rated_at` | same | `participant`, `self_report` |
| `opportunity.pre_planned@1` | `value` `yes`/`no`, `channel`, `revision`, `answered_at` | same | `participant`, `self_report` |

### Assumptions built in (the design note's open items, defaults taken)

- Labels: Not a fit / Weak fit / OK fit / Good fit / Great fit, pinned as `match_fit_5_v1`.
- Revision window 24 h; later taps answer "This question has closed." and record nothing.
- An acceptance rolled over by the 3-per-evening cap expires unasked after 3 village days.
- The cap counts card pairs only: the trigger keeps no count of the day's other proactive deliveries.
- The agent acknowledges in at most one short line, or stays silent (`tools.md`).
- The cards reuse the "Evening questions" stop/manage toggle and its manage line.
- The counterpart's cleaned name and Index's cleaned headline appear on the card.
- The old text ask stays in the tree behind `AV_OUTCOME_TEXT_ASK` (default off) for one release.
- The cleaned name is kept on the ledger (a 0600 file in the home) for the injected line.

### Switches and files

| | |
|---|---|
| `AV_RATE_CARDS` | `1|true|yes|on` sends cards (process environment, else `$HERMES_HOME/.env`). Default off: stages are left in place, taps still answer. |
| `AV_RATE_SESSION_KEY` | overrides the injection target (default `agent:main:telegram:dm:<home chat id>`) |
| `AV_OUTCOME_TEXT_ASK` | av-events: the old text ask's arming, answers and pass (default off) |
| `av-events/proactive/rating/stage-<id>.json` | the trigger's stage, consumed by the pick-up |
| `av-events/proactive/rated.json` | the ledger: nonce, chat and message ids, times, both answers, the name |
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
   AV_RATE_CARDS=1
   TELEGRAM_HOME_CHANNEL=<your Telegram user id>
   AV_TENANT_ID=local-test
   ```

   Without `AV_EVENTS_TOKEN` / `AV_EVENTS_URL` the events are written to av-events' local buffer
   and never posted; set both to a local ingest (`agentvillage-data`, `docker compose up`,
   `bun run src/ingest/server.ts`) to see them land in `events.events`.

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
   `av-rate: tenant=local-te outcome=pickup sent=1`. Tap a number: the toast says `Recorded: ...`,
   the button gets a check mark, card 2 arrives (`outcome=recorded`, `outcome=planned_sent`). Tap
   Yes or No: `outcome=injected` and the bot's next turn is the agent reacting to
   `[Rating recorded] Maya: 4/5 match fit; already planned: no.` (with the gate off you see
   `outcome=inject_refused` and Hermes's own warning naming `allow_gateway_injection`).

6. Check the files and events:

   ```bash
   cat ~/.hermes/av-events/proactive/rated.json | python3 -m json.tool
   ls ~/.hermes/av-events/proactive/rating-events/        # emptied by av-events within a minute
   grep -h '"opportunity\.\(rating_asked\|rated\|pre_planned\)"' ~/.hermes/av-events/buffer* 2>/dev/null | head
   ```

   With a local ingest: `select event_type, actor, payload from events.events where event_type like 'opportunity.rat%' or event_type = 'opportunity.pre_planned' order by occurred_at;`

To test the trigger itself instead of `--stage-test`, run the evening action with the plugin's seams
in `skills/index-network/scripts/tests/rating-cards.test.ts`, or on a box with an Index key:
`hermes cron run <id of "Edge — evening questions">`.

## Tests

```bash
python -m pytest plugins/av-rate plugins/av-events/tests/test_rating_cards.py -q
bun test skills/index-network/scripts/tests/rating-cards.test.ts install/tests/av_rate.test.ts install/tests/proactive_jobs.test.ts
```
