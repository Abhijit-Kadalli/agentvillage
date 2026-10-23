# `av-elicit`: GC-ELICIT on the box

The box half of the GODCONST elicitation follow-up: after a pool closes, the resident's own agent asks
them a few short questions about ODIN's constitution over a few days, and records each question and
answer. The control plane decides when (contract v1 §1) and writes notice files; this plugin injects them
into the resident's Telegram DM session, reports how much the human has written, and gives the agent the
`elicitation_record` tool. Contract sections: 1 (quiet hours), 3a (files the control plane writes), 3b
(files this plugin writes), 3c (the tool's records).

Python 3.9+, standard library only. No hooks, one daemon thread, one tool. Fail-open: every failure is a
log code; nothing raises into the gateway. Logs carry codes and counts only, never a notice's, question's
or answer's text.

```
plugins/av-elicit/
  plugin.yaml   manifest (kind: backend, provides_tools: elicitation_record)
  __init__.py   register(ctx), the inject pass, the probe, the tool
  tests/        pytest suite; a fake ctx and a temp state.db, never imports Hermes
```

## Files (all under `$HERMES_HOME/av-events/elicit/`)

| Path | Written by | Meaning |
|---|---|---|
| `inject/<unix_ms>-<open\|next\|replan>.txt` | control plane | One notice. An optional first line `#trigger=<opener\|answer\|idle\|human_message\|replan>` is metadata: stripped before injection, read back for records. |
| `inject/<file>.done` | this plugin | The gateway accepted the injection. A rename of the `.txt`, with mtime set to the accept time (the control plane reads it as `delivered_at` for `open`; it counts `.done` files as `nudges_sent`). |
| `inject/<file>.skipped` | this plugin | Not injected: the `closed` marker was present, the file was older than 24 h (by its `unix_ms` prefix), or it was unusable (empty after the trigger line, over 32 KiB, not UTF-8, not a regular file). |
| `closed` | control plane | Empty marker. While present nothing is injected, pending `.txt` files become `.skipped`, the probe stops and the tool refuses. |
| `probe.json` | this plugin | `{"human_messages_since": <unix_ms>, "count": n, "last_human_at": <unix_ms>\|null}` (0600). |
| `records/<unix_ms>-<record_id>.json` | the tool | One record per call (0600, dir 0700), written by temp file and rename. The control plane forwards and renames them. |

## The inject pass (every 5 s)

1. No `.txt`: nothing to do.
2. `closed` present: every `.txt` becomes `.skipped`.
3. Any `.txt` staged more than 24 h ago becomes `.skipped` (quiet hours and the ballot hold included).
4. 22:00 to 08:00 IST: hold (the file stays `.txt`).
5. `$HERMES_HOME/av-events/godconst/page-open` exists (av-godconst's empty marker while a sent ballot card
   page still has unrated cards): hold, exactly as in quiet hours. Nothing is consumed or skipped for this
   reason; only step 3's 24 h age cap skips a held file.
6. No session key (`AV_ELICIT_SESSION_KEY`, else `agent:main:telegram:dm:<TELEGRAM_HOME_CHANNEL>`): wait.
7. No row in `state.db` `sessions` with `source='telegram'` and that `session_key`: wait (the gateway can
   inject only into a session it can look up; one exists after the human's first message to the bot).
8. Inject the oldest file only (one per pass) through `ctx.inject_message(text, session_key=...)`. Accepted:
   rename `.done`. Refused (flag off, no live gateway) or raised: the file stays and is retried next pass.

## The probe (every 60 s)

While any `.txt` or `.done` exists, an `open` notice has been injected (`*-open.done`) and no `closed`
marker exists: count the `user`-role messages in `source='telegram'` sessions with `timestamp` at or after
the earliest `*-open.done` mtime, excluding rows whose content starts with `[Agent Village notice` (our own
injected notices), and write `probe.json`. `state.db` is opened read-only (`mode=ro`); an unreadable store
writes nothing. The control plane may still run its own probe when the file is more than 5 minutes stale.

## The tool: `elicitation_record`

Schema (what the agent sees): `kind` (required: `question` | `answer` | `stop`), `question_no` (required,
integer from 1), `category` (a category slug), `form` (question: `open` | `trade_off` | `direct_rating` |
`other`), `text` (required for question and answer, at most 4000 characters), `takeaway` (answer, at most
2000), `statement_ids` (answer, a list of ids such as `s004`).

The record adds `record_id` (uuid4), `recorded_at` (ISO, UTC) and `trigger`: for a question, the trigger of
the notice injected last (its `#trigger=` line, else `open` -> `opener`, `next` -> `answer`, `replan` ->
`replan`), never the agent's. Fields that do not belong to the kind are written as `null` (`[]` for
`statement_ids`); a question without a `form` is `other`.

It refuses (returns `{"error": "..."}`, never raises) outside a Telegram DM session (the calling
`session_id`'s `state.db` row must be `source='telegram'`, `chat_type='dm'`, and the resident's own session
key when one is configured), when no window is open, on invalid arguments, and past 200 records.
Success returns one line, e.g. `Recorded question 2 (privacy_and_consent).`

## Configuration (set by the installer, `install/av_elicit.ts`)

| Key | Value | Why |
|---|---|---|
| `plugins.enabled` | contains `av-elicit` | Hermes loads it at the next gateway start. |
| `plugins.entries.av-elicit.allow_gateway_injection` | `true` | Without it Hermes refuses every `inject_message`; files wait as `.txt`. |
| `memory.memory_char_limit` | `8000` if lower | The agent's gap list needs the room (contract 3a; the control plane also sets it). |

Environment: `TELEGRAM_HOME_CHANNEL` (the resident's chat id, already written for the gateway) or
`AV_ELICIT_SESSION_KEY` (an explicit session key; tests and odd namespaces). Read from the process
environment, then `$HERMES_HOME/.env`. There is no on switch here: the control plane's gates
(`GODCONST_ELICIT_ENABLED`, `GODCONST_ELICIT_TENANTS`) decide whether any file is ever staged, and with no
files the plugin does nothing but list one empty directory every 5 s.

## Tests

```
python3 -m pytest plugins/av-elicit/tests
```
