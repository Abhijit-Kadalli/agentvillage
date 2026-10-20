"""av-rate: the suggestion rating cards (data docs/design/suggestion-rating.md).

Replaces the evening outcome ask's text question ("Did you and <name> meet? Reply met, not
useful, or missed.", overlay #198) with two Telegram button cards about the suggestion itself,
sent by the resident's own bot and answered with a tap:

  Card 1  "How good a match was this suggestion from <agentName>?"  five numeral buttons 1..5
          (labels in the body: Not a fit / Weak fit / OK fit / Good fit / Great fit, scale
          ``match_fit_5_v1``) and a privacy line.
  Card 2  "Did you already plan this meetup?"  [Yes] [No], sent after card 1's first tap.

**Who decides what to ask.** The evening trigger (``skills/index-network/scripts/rating-cards.ts``
through ``proactive.ts``) picks the accepted connections to ask about and writes one stage file per
subject into ``av-events/proactive/rating/`` (0600, this user; the cleaned name and headline are the
only text, and they never reach an event). This plugin sends the cards from those files, records
the taps, hands the events to av-events, and tells the agent.

**Wiring** (Hermes v2026.9.24, the av-vote precedent). ``ctx.register_platform_handler("telegram",
factory)``: the Telegram adapter's ``connect()`` calls the factory with the PTB ``Application`` and
the adapter before its own handlers, so a ``CallbackQueryHandler`` scoped to ``^avr:`` sees every
``avr:`` tap and nothing else; registered ``block=False`` (Hermes's Application processes one update
at a time). The same factory starts the pick-up: PTB's job queue every ``PICKUP_INTERVAL_S`` when the
``job-queue`` extra is installed, else an asyncio task on the gateway loop. The pick-up sends the
staged cards and closes the window on the old ones.

**callback_data** (under Telegram's 64 bytes): ``avr:f:<1-5>:<nonce>`` for card 1 and
``avr:p:<y|n>:<nonce>`` for card 2. ``<nonce>`` is the first 22 base64url characters of
HMAC-SHA256(key, "avr|<opportunity_id>|match_fit_5_v1") under the tenant's av-events key
(``av-events/hash.key``; this plugin's own ``av-events/av-rate.key`` when av-events has made none
yet). The ledger maps a nonce back to its opportunity; a nonce not on file answers "no longer
valid". The index/nonce are UX and routing only: the owner check is what authorises a tap.

**A tap**: owner only (the box's own resident, in their private chat with the bot: the home
channel's ids, ``TELEGRAM_HOME_CHANNEL``, or Hermes's approved pairings, exactly av-vote's rule);
inside the 24 h window after the card went out, else "This question has closed." and no event; a
re-tap is a revision (``revision`` 1, 2, ...; last wins downstream). Answers the tap with
"Recorded: <label>", marks the chosen button, sends card 2 after card 1's first tap, and hands the
event over. Double taps on one card while the first is being recorded are answered "Still
recording..." and do nothing.

**Three sinks per tap.**
1. The events, through av-events (``plugins/av-events/_rating_cards.py`` reads
   ``av-events/proactive/rating-events/*.json`` on the flusher's cadence and emits
   ``opportunity.rating_asked@1`` / ``opportunity.rated@1`` / ``opportunity.pre_planned@1`` with ids
   derived from (type, opportunity, card, revision), so a re-send never doubles a row). This plugin
   never posts to the ingest API itself and never builds an envelope.
2. The agent: after card 2 resolves (or when the window closes with only card 1 answered) one line is
   injected into the resident's DM session through ``ctx.inject_message`` (gated by Hermes on
   ``plugins.entries.av-rate.allow_gateway_injection: true``; refused or no gateway: a code, never a
   blocked tap): ``[Rating recorded] <Name>: <value>/5 match fit; already planned: <yes|no|not
   answered>.`` Hermes persists that turn as ``internal_notification`` (actor ``system`` on the data
   side), so it reaches the agent's memory and the archive.
3. The ledger ``av-events/proactive/rated.json`` (ids, nonces, message ids, times, the two answers,
   and the cleaned name for the injected line), which the trigger reads as "asked".

**Switches.** Cards only with ``AV_RATE_CARDS`` on (``1|true|yes|on``, process environment then
``$HERMES_HOME/.env``); off, stages are left where they are and taps still answer. Logging: codes
and counts and the tenant's first eight characters; never a name, a token, a user id or callback
data.

**Trust boundary.** Everything here is in the agent's home, writable by the agent; the file checks
catch accidents, not forgers. The data side caps a plugin token's events at agent-asserted (the
asks) and self-reported (the answers). See the design note §5 and §7.

Python 3.11, standard library only; the Telegram SDK is imported inside the factory.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import html
import itertools
import json
import logging
import os
import re
import secrets
import stat
import threading
import time
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

PLUGIN_ID = "av-rate"
PREFIX = "avr:"
#: The PTB handler's pattern: scoped, so core callback flows fall through to Hermes.
HANDLER_PATTERN = r"^avr:"
NONCE_CHARS = 22
CALLBACK_DATA = re.compile(r"^avr:(f:[1-5]|p:[yn]):([A-Za-z0-9_-]{22})$")
#: Telegram's limit on callback_data (bytes, UTF-8).
CALLBACK_DATA_MAX_BYTES = 64

SCALE = "match_fit_5_v1"
QUESTION_VERSION = SCALE
CHANNEL = "telegram_button"
WINDOW_HOURS = 24
WINDOW_S = WINDOW_HOURS * 3600
CARD_FIT = "fit"
CARD_PLANNED = "planned"
LABELS = {1: "Not a fit", 2: "Weak fit", 3: "OK fit", 4: "Good fit", 5: "Great fit"}
PLANNED_LABELS = {"y": "Yes", "n": "No"}
PLANNED_VALUES = {"y": "yes", "n": "no"}
CHECK = "✅ "
#: DATA-373: every scheduled message ends with its manage line, this card too.
MANAGE_LINE = "(Evening questions message - you can ask me to stop or manage it)"
PRIVACY_LINE = "Private: only you and the research team see this. {name} does not."
QUESTION_FIT = "How good a match was this suggestion from {agent}?"
QUESTION_PLANNED = "Did you already plan this meetup?"

ON_SWITCH = "AV_RATE_CARDS"
SESSION_KEY_ENV = "AV_RATE_SESSION_KEY"
HOME_CHANNEL_ENV = "TELEGRAM_HOME_CHANNEL"
TENANT_ENVS = ("AV_TENANT_ID", "TENANT_ID")
TRUTHY = frozenset({"1", "true", "yes", "on"})

PICKUP_INTERVAL_S = 60.0
#: A stage older than this when the pick-up sees it is dropped (and counted): the trigger
#: stages again the next evening, since the subject is not on the ledger.
STAGE_MAX_AGE_S = 6 * 3600
#: A stage whose send keeps failing is dropped after this many passes.
SEND_ATTEMPTS_MAX = 3
STAGE_MAX_BYTES = 4096
LEDGER_MAX_BYTES = 512 * 1024
#: Cards kept on the ledger at most; the oldest closed ones go first.
LEDGER_MAX_CARDS = 500
NAME_MAX = 80
HEADLINE_MAX = 120
AGENT_NAME_MAX = 40
#: An envelope id (agentvillage-data src/envelope.ts ID_PATTERN).
ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
_HEX64 = re.compile(r"^[0-9a-f]{64}$")
_TELEGRAM_USER = re.compile(r"[1-9][0-9]{0,19}")
#: answerCallbackQuery text is at most 200 characters.
ANSWER_MAX = 200
DIR_MODE = 0o700
FILE_MODE = 0o600

NOT_YOURS = "This card is not yours"
BAD_BUTTON = "This button is not valid."
INVALID = "This card is no longer valid."
CLOSED = "This question has closed."
IN_FLIGHT = "Still recording..."
FAILED = "Could not record that. Try again."

#: Outcome codes (the only thing logged besides the tenant's id8).
RECORDED = "recorded"

# Cards whose tap is being recorded right now: (chat id, message id).
_in_flight: set[tuple[str, str]] = set()
_LEDGER_LOCK = threading.RLock()
#: The plugin context Hermes handed `register`, for `inject_message`.
_CTX: Any = None
#: Stage files whose send failed, by name -> attempts.
_SEND_FAILURES: dict[str, int] = {}
#: Hand-off files written by this process, in order: the name sorts the way they were written.
_HANDOFF_SEQ = itertools.count(1)


# --------------------------------------------------------------------------- env, paths, logging


def hermes_home() -> str:
    return os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")


def _dotenv(home: str) -> dict[str, str]:
    parsed: dict[str, str] = {}
    try:
        with open(os.path.join(home, ".env"), encoding="utf-8-sig") as handle:
            for line in handle:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                name, _, value = line.partition("=")
                parsed[name.strip()] = value.strip().strip("'\"")
    except OSError:
        return {}
    return parsed


def env(name: str, home: Optional[str] = None) -> str:
    """The process environment (a present, blank value is authoritative), else `$HERMES_HOME/.env`."""
    raw = os.environ.get(name)
    if raw is not None:
        return raw.strip()
    return _dotenv(home or hermes_home()).get(name, "").strip()


def cards_on(home: Optional[str] = None) -> bool:
    return env(ON_SWITCH, home).lower() in TRUTHY


def state_dir(home: Optional[str] = None) -> str:
    return os.path.join(home or hermes_home(), "av-events")


def stage_dir(home: Optional[str] = None) -> str:
    return os.path.join(state_dir(home), "proactive", "rating")


def events_dir(home: Optional[str] = None) -> str:
    return os.path.join(state_dir(home), "proactive", "rating-events")


def ledger_path(home: Optional[str] = None) -> str:
    return os.path.join(state_dir(home), "proactive", "rated.json")


def tenant_id8() -> str:
    for name in TENANT_ENVS:
        value = os.environ.get(name, "").strip()
        if value:
            return re.sub(r"[^A-Za-z0-9-]", "", value)[:8]
    return "-"


def _log(outcome: str, **counts: int) -> None:
    extra = "".join(f" {key}={value}" for key, value in sorted(counts.items()))
    logger.info("av-rate: tenant=%s outcome=%s%s", tenant_id8(), outcome, extra)


def now_iso(epoch: Optional[float] = None) -> str:
    stamp = datetime.fromtimestamp(time.time() if epoch is None else epoch, tz=timezone.utc)
    return stamp.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def epoch_from_iso(value: Any) -> Optional[float]:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        stamp = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if stamp.tzinfo is None:
        return None
    return stamp.timestamp()


# --------------------------------------------------------------------------- private files


def _uid() -> Optional[int]:
    return os.getuid() if hasattr(os, "getuid") else None


def private_dir(path: str) -> bool:
    try:
        st = os.lstat(path)
    except OSError:
        return False
    uid = _uid()
    return stat.S_ISDIR(st.st_mode) and (uid is None or st.st_uid == uid) and not st.st_mode & 0o022


def private_file(path: str, max_bytes: int) -> tuple[Any, Optional[str]]:
    """`(data, None)`, or `(None, code)` (`_outcome_ask.private_file`'s codes)."""
    if not private_dir(os.path.dirname(path)):
        return None, "missing" if not os.path.lexists(path) else "bad_dir"
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return None, "missing"
    except OSError:
        return None, "unreadable"
    uid = _uid()
    if not stat.S_ISREG(st.st_mode):
        return None, "not_regular"
    if uid is not None and st.st_uid != uid:
        return None, "foreign_owner"
    if st.st_mode & 0o077:
        return None, "not_private"
    if st.st_size > max_bytes:
        return None, "too_big"
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd, encoding="utf-8") as handle:
            raw = handle.read(max_bytes + 1)
        if len(raw) > max_bytes:
            return None, "too_big"
        return json.loads(raw), None
    except (OSError, ValueError):
        return None, "unreadable"


def write_private(path: str, data: Any) -> None:
    """By temp file and rename, 0600 in a 0700 directory. Raises OSError."""
    os.makedirs(os.path.dirname(path), mode=DIR_MODE, exist_ok=True)
    tmp = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0), FILE_MODE)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, separators=(",", ":"))
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _unlink(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass


def _listing(path: str) -> list[str]:
    if not private_dir(path):
        return []
    try:
        return sorted(name for name in os.listdir(path) if name.endswith(".json") and not name.endswith(".tmp"))
    except OSError:
        return []


# --------------------------------------------------------------------------- key, nonce, hashes


def hash_key(home: Optional[str] = None) -> Optional[bytes]:
    """The tenant's av-events key (`av-events/hash.key`, 64 hex), else this plugin's own
    `av-events/av-rate.key` (made once, 0600). None only when neither can be read or made."""
    directory = state_dir(home)
    for name in ("hash.key", "av-rate.key"):
        try:
            with open(os.path.join(directory, name), "rb") as handle:
                text = handle.read(256).decode("ascii", errors="replace").strip()
        except OSError:
            continue
        if _HEX64.match(text):
            return bytes.fromhex(text)
    try:
        os.makedirs(directory, mode=DIR_MODE, exist_ok=True)
        path = os.path.join(directory, "av-rate.key")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, FILE_MODE)
        value = secrets.token_hex(32)
        with os.fdopen(fd, "w", encoding="ascii") as handle:
            handle.write(value + "\n")
        return bytes.fromhex(value)
    except FileExistsError:
        try:
            with open(os.path.join(directory, "av-rate.key"), "rb") as handle:
                text = handle.read(256).decode("ascii", errors="replace").strip()
            return bytes.fromhex(text) if _HEX64.match(text) else None
        except (OSError, ValueError):
            return None
    except OSError:
        return None


def make_nonce(key: bytes, opportunity_id: str) -> str:
    digest = hmac.new(key, f"avr|{opportunity_id}|{SCALE}".encode("utf-8"), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")[:NONCE_CHARS]


def keyed_hash(key: bytes, text: str) -> str:
    """As av-events hashes `message.out` content: HMAC-SHA256 under the tenant's key, hex."""
    return hmac.new(key, text.encode("utf-8", errors="surrogatepass"), hashlib.sha256).hexdigest()


# --------------------------------------------------------------------------- callback data, keyboards


def parse_callback(data: Any) -> Optional[tuple[str, str, str]]:
    """``(card, choice, nonce)`` for a well-formed ``avr:`` value inside 64 bytes: card ``fit`` with
    choice ``1``..``5``, or ``planned`` with ``y``/``n``. Else None."""
    if not isinstance(data, str) or len(data.encode("utf-8")) > CALLBACK_DATA_MAX_BYTES:
        return None
    match = CALLBACK_DATA.fullmatch(data)
    if match is None:
        return None
    kind, choice = match.group(1).split(":", 1)
    return (CARD_FIT if kind == "f" else CARD_PLANNED), choice, match.group(2)


def fit_callback(value: int, nonce: str) -> str:
    return f"avr:f:{value}:{nonce}"


def planned_callback(choice: str, nonce: str) -> str:
    return f"avr:p:{choice}:{nonce}"


def fit_rows(nonce: str, make_button: Callable[[str, str], Any], selected: Optional[int] = None) -> list[list[Any]]:
    """One row of five numeral buttons; the selected one carries a check mark."""
    return [[make_button((CHECK if selected == value else "") + str(value), fit_callback(value, nonce)) for value in range(1, 6)]]


def planned_rows(nonce: str, make_button: Callable[[str, str], Any], selected: Optional[str] = None) -> list[list[Any]]:
    return [[make_button((CHECK if selected == choice else "") + PLANNED_LABELS[choice], planned_callback(choice, nonce)) for choice in ("y", "n")]]


def fit_text(agent_name: str, name: str, headline: Optional[str]) -> str:
    """Card 1, HTML-escaped. The headline line is left out when the trigger withheld it."""
    lines = [html.escape(QUESTION_FIT.format(agent=agent_name))]
    lines.append(html.escape(f"{name}, about {headline}" if headline else name))
    lines.append("")
    lines += [html.escape(f"{value}  {label}") for value, label in LABELS.items()]
    lines.append("")
    lines.append(html.escape(PRIVACY_LINE.format(name=name)))
    lines.append("")
    lines.append(html.escape(MANAGE_LINE))
    return "\n".join(lines)


def planned_text() -> str:
    return html.escape(QUESTION_PLANNED)


# --------------------------------------------------------------------------- owner


def _positive_id(value: Any) -> Optional[str]:
    text = str(value).strip() if isinstance(value, (int, str)) and not isinstance(value, bool) else ""
    return text if _TELEGRAM_USER.fullmatch(text) else None


def owner_ids(adapter: Any = None) -> set[str]:
    """av-vote's rule: the adapter config's home channel (`user_id`, and `chat_id` when a positive
    DM id) and `TELEGRAM_HOME_CHANNEL`."""
    found: set[str] = set()
    try:
        home = getattr(getattr(adapter, "config", None), "home_channel", None)
        for field in ("user_id", "chat_id"):
            value = home.get(field) if isinstance(home, dict) else getattr(home, field, None)
            ident = _positive_id(value) if value is not None else None
            if ident:
                found.add(ident)
    except Exception:  # noqa: BLE001 - an unreadable config falls back to the env
        pass
    env_id = _positive_id(os.environ.get(HOME_CHANNEL_ENV, ""))
    if env_id:
        found.add(env_id)
    return found


def home_chat_id(adapter: Any = None) -> Optional[str]:
    """Where the cards go: the home channel's positive `chat_id`, else its `user_id`, else
    `TELEGRAM_HOME_CHANNEL`. None when the box names no DM."""
    try:
        home = getattr(getattr(adapter, "config", None), "home_channel", None)
        for field in ("chat_id", "user_id"):
            value = home.get(field) if isinstance(home, dict) else getattr(home, field, None)
            ident = _positive_id(value) if value is not None else None
            if ident:
                return ident
    except Exception:  # noqa: BLE001
        pass
    return _positive_id(os.environ.get(HOME_CHANNEL_ENV, ""))


def paired_on_box(user: str) -> bool:
    try:
        from gateway.pairing import PairingStore  # noqa: PLC0415 - Hermes, in-process on a box

        return bool(PairingStore().is_approved("telegram", user))
    except Exception:  # noqa: BLE001
        return False


def is_owner_tap(adapter: Any, user: Optional[str], chat: Optional[str], chat_type: Optional[str]) -> bool:
    """The tap is the resident's, in the resident's own DM with the bot."""
    if user is None:
        return False
    if chat is not None and chat != user:
        return False
    if isinstance(chat_type, str) and chat_type and chat_type != "private":
        return False
    if user in owner_ids(adapter):
        return True
    return chat is not None and paired_on_box(user)


# --------------------------------------------------------------------------- the ledger


def empty_ledger() -> dict:
    return {"v": 1, "cards": {}}


def load_ledger(home: Optional[str] = None) -> tuple[dict, Optional[str]]:
    """`(ledger, None)`, or `(empty, code)` when there is none yet (`missing`) or it cannot be
    trusted (`private_file`'s other codes, `bad_shape`): then nothing is written over it."""
    data, why = private_file(ledger_path(home), LEDGER_MAX_BYTES)
    if why is not None:
        return empty_ledger(), why
    if not isinstance(data, dict) or data.get("v") != 1 or not isinstance(data.get("cards"), dict):
        return empty_ledger(), "bad_shape"
    return data, None


def save_ledger(ledger: dict, home: Optional[str] = None) -> None:
    cards = ledger["cards"]
    if len(cards) > LEDGER_MAX_CARDS:
        # The oldest closed cards go first.
        ordered = sorted(cards.items(), key=lambda item: str(item[1].get("sent_at", "")))
        for key, _ in ordered[: len(cards) - LEDGER_MAX_CARDS]:
            cards.pop(key, None)
    write_private(ledger_path(home), ledger)


def card_for_nonce(ledger: dict, nonce: str) -> Optional[tuple[str, dict]]:
    for opportunity_id, card in ledger["cards"].items():
        if isinstance(card, dict) and card.get("nonce") == nonce:
            return opportunity_id, card
    return None


def is_closed(card: dict, now: float) -> bool:
    closes = epoch_from_iso(card.get("closes_at"))
    return closes is None or now > closes


# --------------------------------------------------------------------------- the stage files


def valid_stage(data: Any) -> Optional[dict]:
    """The trigger's stage (rating-cards.ts `RatingStage`), or None unless exactly the shape:
    `v` 1, `opportunity_id` an envelope id, `intention_id` an id or null, `name` (1..80),
    `headline` (1..120 or null), `agent_name` (1..40), `staged_at` ISO, `date` YYYY-MM-DD."""
    keys = {"v", "opportunity_id", "intention_id", "name", "headline", "agent_name", "staged_at", "date"}
    if not isinstance(data, dict) or set(data) != keys or data["v"] != 1 or type(data["v"]) is not int:
        return None
    opportunity = data["opportunity_id"]
    if not (isinstance(opportunity, str) and ID_PATTERN.fullmatch(opportunity)):
        return None
    intention = data["intention_id"]
    if intention is not None and not (isinstance(intention, str) and ID_PATTERN.fullmatch(intention)):
        return None
    name, headline, agent = data["name"], data["headline"], data["agent_name"]
    if not (isinstance(name, str) and 0 < len(name) <= NAME_MAX and name == name.strip()):
        return None
    if headline is not None and not (isinstance(headline, str) and 0 < len(headline) <= HEADLINE_MAX):
        return None
    if not (isinstance(agent, str) and 0 < len(agent) <= AGENT_NAME_MAX):
        return None
    if epoch_from_iso(data["staged_at"]) is None or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(data["date"])):
        return None
    return {
        "opportunity_id": opportunity.lower() if re.fullmatch(r"[0-9a-fA-F-]{36}", opportunity) else opportunity,
        "intention_id": intention,
        "name": name,
        "headline": headline,
        "agent_name": agent,
        "staged_at": data["staged_at"],
    }


# --------------------------------------------------------------------------- the hand-off to av-events


def hand_off(record: dict, home: Optional[str] = None, now: Optional[float] = None) -> bool:
    """Write one event record for av-events' `_rating_cards.tick` (one file per record:
    `{"v":1,"written_at":<ISO>,"records":[record]}`). The record carries ids, codes, a value and
    times only. True when written."""
    stamp = time.time() if now is None else now
    try:
        directory = events_dir(home)
        os.makedirs(directory, mode=DIR_MODE, exist_ok=True)
        path = os.path.join(directory, f"{int(stamp * 1000)}-{os.getpid()}-{next(_HANDOFF_SEQ):08d}-{secrets.token_hex(4)}.json")
        write_private(path, {"v": 1, "written_at": now_iso(stamp), "records": [record]})
        return True
    except OSError:
        _log("handoff_unwritable")
        return False


def asked_record(opportunity_id: str, intention_id: Optional[str], card: str, message_hash: str, at: str) -> dict:
    return {"event_type": "opportunity.rating_asked", "opportunity_id": opportunity_id, "intention_id": intention_id,
            "card": card, "revision": 1, "value": None, "at": at, "message_hash": message_hash}


def rated_record(opportunity_id: str, intention_id: Optional[str], value: int, revision: int, at: str) -> dict:
    return {"event_type": "opportunity.rated", "opportunity_id": opportunity_id, "intention_id": intention_id,
            "card": CARD_FIT, "revision": revision, "value": value, "at": at, "message_hash": None}


def planned_record(opportunity_id: str, intention_id: Optional[str], value: str, revision: int, at: str) -> dict:
    return {"event_type": "opportunity.pre_planned", "opportunity_id": opportunity_id, "intention_id": intention_id,
            "card": CARD_PLANNED, "revision": revision, "value": value, "at": at, "message_hash": None}


# --------------------------------------------------------------------------- the agent hand-off


def injected_line(card: dict) -> str:
    fit = card.get("fit") or {}
    planned = card.get("planned") or {}
    value = fit.get("value")
    planned_text_value = planned.get("value") if planned.get("value") in ("yes", "no") else "not answered"
    return f"[Rating recorded] {card.get('name', 'This person')}: {value}/5 match fit; already planned: {planned_text_value}."


def session_key_for(chat_id: str) -> str:
    """The resident's DM session key (`gateway/session.py` build_session_key: `<ns>:<platform>:
    <chat_type>:<chat_id>`, the default namespace `agent:main`), or `AV_RATE_SESSION_KEY` when set."""
    override = env(SESSION_KEY_ENV)
    return override or f"agent:main:telegram:dm:{chat_id}"


def inject(card: dict, chat_id: str, ctx: Any = None) -> str:
    """One line into the resident's DM session. A code: `injected`, `inject_no_ctx`,
    `inject_refused` (Hermes said no: the config flag, no live gateway) or `inject_error`."""
    context = ctx if ctx is not None else _CTX
    inject_fn = getattr(context, "inject_message", None)
    if not callable(inject_fn):
        return "inject_no_ctx"
    try:
        accepted = inject_fn(injected_line(card), session_key=session_key_for(chat_id))
    except Exception:  # noqa: BLE001
        return "inject_error"
    return "injected" if accepted else "inject_refused"


def ready_to_inject(card: dict, now: float) -> bool:
    """After card 2 resolves, or when the window closes with card 1 answered."""
    if card.get("injected") or not card.get("fit"):
        return False
    return bool(card.get("planned")) or is_closed(card, now)


# --------------------------------------------------------------------------- the pick-up


async def pick_up(bot: Any, adapter: Any, make_button: Callable[[str, str], Any], make_markup: Callable[[list], Any],
                  home: Optional[str] = None, now: Optional[float] = None, ctx: Any = None) -> dict:
    """One pass: send the staged cards (AV_RATE_CARDS on), then inject the lines that are due.
    Returns code -> count; never raises."""
    codes: dict[str, int] = {}
    stamp = time.time() if now is None else now

    def count(code: str, n: int = 1) -> None:
        if n:
            codes[code] = codes.get(code, 0) + n

    try:
        with _LEDGER_LOCK:
            ledger, why = load_ledger(home)
            if why not in (None, "missing"):
                count(f"ledger_{why}")
                return codes
            if cards_on(home):
                await _send_staged(bot, adapter, make_button, make_markup, ledger, home, stamp, count)
            await _inject_due(ledger, home, stamp, count, ctx)
    except Exception:  # noqa: BLE001 - the pass never raises into the gateway
        logger.warning("av-rate: tenant=%s outcome=pickup_error", tenant_id8())
        count("pickup_error")
    if codes:
        _log("pickup", **codes)
    return codes


async def _send_staged(bot: Any, adapter: Any, make_button: Callable[[str, str], Any], make_markup: Callable[[list], Any],
                       ledger: dict, home: Optional[str], now: float, count: Callable[..., None]) -> None:
    folder = stage_dir(home)
    if os.path.lexists(folder) and not private_dir(folder):
        count("stage_folder_not_private")
        return
    names = _listing(folder)
    if not names:
        return
    chat = home_chat_id(adapter)
    if chat is None:
        count("no_home_chat", len(names))
        return
    key = hash_key(home)
    if key is None:
        count("no_key", len(names))
        return
    for name in names:
        path = os.path.join(folder, name)
        data, why = private_file(path, STAGE_MAX_BYTES)
        if why is not None:
            count(f"stage_dropped_{why}")
            _unlink(path)
            continue
        stage = valid_stage(data)
        if stage is None:
            count("stage_dropped_bad_shape")
            _unlink(path)
            continue
        staged = epoch_from_iso(stage["staged_at"]) or 0.0
        if now - staged > STAGE_MAX_AGE_S:
            count("stage_dropped_stale")
            _unlink(path)
            continue
        opportunity_id = stage["opportunity_id"]
        if opportunity_id in ledger["cards"]:
            count("stage_dropped_already_asked")
            _unlink(path)
            continue
        nonce = make_nonce(key, opportunity_id)
        text = fit_text(stage["agent_name"], stage["name"], stage["headline"])
        try:
            message = await bot.send_message(chat_id=int(chat), text=text, parse_mode="HTML",
                                             reply_markup=make_markup(fit_rows(nonce, make_button)),
                                             disable_web_page_preview=True)
        except Exception:  # noqa: BLE001 - Telegram down, blocked bot, ...
            _SEND_FAILURES[name] = _SEND_FAILURES.get(name, 0) + 1
            if _SEND_FAILURES[name] >= SEND_ATTEMPTS_MAX:
                _SEND_FAILURES.pop(name, None)
                _unlink(path)
                count("stage_dropped_send_failed")
            else:
                count("send_failed")
            continue
        _SEND_FAILURES.pop(name, None)
        sent_at = now_iso(now)
        ledger["cards"][opportunity_id] = {
            "nonce": nonce,
            "intention_id": stage["intention_id"],
            "name": stage["name"],
            "agent_name": stage["agent_name"],
            "chat_id": chat,
            "message_id": getattr(message, "message_id", None),
            "planned_message_id": None,
            "sent_at": sent_at,
            "closes_at": now_iso(now + WINDOW_S),
            "fit": None,
            "planned": None,
            "injected": False,
        }
        save_ledger(ledger, home)
        _unlink(path)
        hand_off(asked_record(opportunity_id, stage["intention_id"], CARD_FIT, keyed_hash(key, text), sent_at), home, now)
        count("sent")


async def _inject_due(ledger: dict, home: Optional[str], now: float, count: Callable[..., None], ctx: Any) -> None:
    changed = False
    for card in ledger["cards"].values():
        if not isinstance(card, dict) or not ready_to_inject(card, now):
            continue
        code = await asyncio.to_thread(inject, card, str(card.get("chat_id", "")), ctx)
        count(code)
        if code in ("injected", "inject_refused", "inject_no_ctx"):
            # Refused is final for this card: Hermes's flag is off or no gateway; a retry every
            # minute would only log. An error is retried next pass.
            card["injected"] = True
            card["injected_code"] = code
            changed = True
    if changed:
        save_ledger(ledger, home)


# --------------------------------------------------------------------------- the tap


def _button_fields(button: Any) -> tuple[str, Any]:
    if isinstance(button, dict):
        return str(button.get("text", "")), button.get("callback_data")
    return str(getattr(button, "text", "") or ""), getattr(button, "callback_data", None)


def _unchecked(text: str) -> str:
    return text[len(CHECK):] if text.startswith(CHECK) else text


def mark_keyboard(rows: Any, data: str, make_button: Callable[[str, str], Any]) -> Optional[list[list[Any]]]:
    """The card's keyboard with a check mark on the tapped ``avr:`` button only (av-vote's)."""
    if not rows:
        return None
    found = changed = False
    out: list[list[Any]] = []
    for row in rows:
        new_row = []
        for button in row or ():
            text, callback = _button_fields(button)
            if isinstance(callback, str) and callback.startswith(PREFIX):
                want = CHECK + _unchecked(text) if callback == data else _unchecked(text)
                found = found or callback == data
                if want != text:
                    changed = True
                    new_row.append(make_button(want, callback))
                    continue
            new_row.append(button)
        out.append(new_row)
    return out if found and changed else None


def _truncate(text: str) -> str:
    return text if len(text) <= ANSWER_MAX else text[: ANSWER_MAX - 3] + "..."


async def _answer(query: Any, text: str) -> None:
    try:
        await query.answer(text=_truncate(text))
    except Exception:  # noqa: BLE001 - an expired query id cannot be answered
        logger.debug("av-rate: answerCallbackQuery failed", exc_info=True)


def record_tap(ledger: dict, opportunity_id: str, card: str, choice: str, now: float, home: Optional[str] = None) -> tuple[str, str, int]:
    """Record one tap on the ledger and hand its event over. `(label, value_text, revision)`.
    The caller holds the ledger lock and has checked the window."""
    entry = ledger["cards"][opportunity_id]
    at = now_iso(now)
    if card == CARD_FIT:
        value = int(choice)
        revision = int((entry.get("fit") or {}).get("revision", 0)) + 1
        entry["fit"] = {"value": value, "revision": revision, "at": at}
        label = LABELS[value]
        hand_off(rated_record(opportunity_id, entry.get("intention_id"), value, revision, at), home, now)
        return label, str(value), revision
    value_text = PLANNED_VALUES[choice]
    revision = int((entry.get("planned") or {}).get("revision", 0)) + 1
    entry["planned"] = {"value": value_text, "revision": revision, "at": at}
    hand_off(planned_record(opportunity_id, entry.get("intention_id"), value_text, revision, at), home, now)
    return PLANNED_LABELS[choice], value_text, revision


def make_handler(adapter: Any = None, *, make_button: Callable[[str, str], Any], make_markup: Callable[[list], Any],
                 home: Optional[str] = None, clock: Callable[[], float] = time.time, ctx: Any = None,
                 send_planned: bool = True) -> Callable[[Any, Any], Awaitable[None]]:
    """The PTB callback for ``avr:`` taps."""

    async def on_tap(update: Any, context: Any = None) -> None:
        query = getattr(update, "callback_query", None)
        if query is None:
            return
        key: Optional[tuple[str, str]] = None
        try:
            data = getattr(query, "data", None)
            user = _positive_id(getattr(getattr(query, "from_user", None), "id", None))
            message = getattr(query, "message", None)
            chat_obj = getattr(message, "chat", None) if message is not None else None
            raw_chat = getattr(chat_obj, "id", None)
            chat = None if raw_chat is None else str(raw_chat).strip()
            chat_type = getattr(chat_obj, "type", None)
            chat_type = getattr(chat_type, "value", chat_type)
            if not is_owner_tap(adapter, user, chat, chat_type):
                _log("not_owner")
                await _answer(query, NOT_YOURS)
                return
            parsed = parse_callback(data)
            if parsed is None:
                _log("bad_data")
                await _answer(query, BAD_BUTTON)
                return
            card_kind, choice, nonce = parsed
            key = (str(chat), str(getattr(message, "message_id", ""))) if message is not None else ("-", nonce)
            if key in _in_flight:
                key = None
                _log("in_flight")
                await _answer(query, IN_FLIGHT)
                return
            _in_flight.add(key)
            now = clock()
            with _LEDGER_LOCK:
                ledger, why = load_ledger(home)
                found = card_for_nonce(ledger, nonce) if why is None else None
                if found is None:
                    _log("unknown_nonce" if why is None else f"ledger_{why}")
                    await _answer(query, INVALID)
                    return
                opportunity_id, entry = found
                if is_closed(entry, now):
                    _log("closed")
                    await _answer(query, CLOSED)
                    return
                first_fit = card_kind == CARD_FIT and not entry.get("fit")
                label, _value, revision = record_tap(ledger, opportunity_id, card_kind, choice, now, home)
                save_ledger(ledger, home)
            _log(RECORDED, revision=revision)
            await _answer(query, f"Recorded: {label}")
            rows = getattr(getattr(message, "reply_markup", None), "inline_keyboard", None)
            marked = mark_keyboard(rows, data, make_button)
            if marked is not None:
                try:
                    await query.edit_message_reply_markup(reply_markup=make_markup(marked))
                except Exception:  # noqa: BLE001 - recorded already; a stale card is cosmetic
                    _log("edit_failed")
            if first_fit and send_planned:
                await _send_planned(query, message, nonce, opportunity_id, make_button, make_markup, home, now)
            if card_kind == CARD_PLANNED:
                with _LEDGER_LOCK:
                    ledger, why = load_ledger(home)
                    entry = ledger["cards"].get(opportunity_id) if why is None else None
                    if entry is not None and ready_to_inject(entry, now):
                        code = await asyncio.to_thread(inject, entry, str(entry.get("chat_id", "")), ctx)
                        _log(code)
                        if code in ("injected", "inject_refused", "inject_no_ctx"):
                            entry["injected"] = True
                            entry["injected_code"] = code
                            save_ledger(ledger, home)
        except Exception:  # noqa: BLE001 - fail-open: never raise into the gateway
            logger.warning("av-rate: tenant=%s outcome=handler_error", tenant_id8())
            await _answer(query, FAILED)
        finally:
            if key is not None:
                _in_flight.discard(key)

    return on_tap


async def _send_planned(query: Any, message: Any, nonce: str, opportunity_id: str, make_button: Callable[[str, str], Any],
                        make_markup: Callable[[list], Any], home: Optional[str], now: float) -> None:
    bot = getattr(message, "get_bot", None)
    bot = bot() if callable(bot) else getattr(query, "bot", None) or getattr(message, "bot", None)
    chat = getattr(getattr(message, "chat", None), "id", None)
    if bot is None or chat is None:
        _log("planned_no_bot")
        return
    try:
        sent = await bot.send_message(chat_id=chat, text=planned_text(), parse_mode="HTML",
                                      reply_markup=make_markup(planned_rows(nonce, make_button)))
    except Exception:  # noqa: BLE001
        _log("planned_send_failed")
        return
    with _LEDGER_LOCK:
        ledger, why = load_ledger(home)
        entry = ledger["cards"].get(opportunity_id) if why is None else None
        if entry is None:
            return
        entry["planned_message_id"] = getattr(sent, "message_id", None)
        save_ledger(ledger, home)
    key = hash_key(home)
    if key is not None:
        hand_off(asked_record(opportunity_id, entry.get("intention_id"), CARD_PLANNED, keyed_hash(key, planned_text()), now_iso(now)), home, now)
    _log("planned_sent")


# --------------------------------------------------------------------------- wiring


def _wire_telegram(application: Any, adapter: Any) -> None:
    """Factory Hermes calls at Telegram connect with the PTB ``Application``; SDK imports stay here."""
    from telegram import InlineKeyboardButton, InlineKeyboardMarkup  # noqa: PLC0415
    from telegram.ext import CallbackQueryHandler  # noqa: PLC0415

    make_button = lambda text, data: InlineKeyboardButton(text=text, callback_data=data)  # noqa: E731
    make_markup = lambda rows: InlineKeyboardMarkup(rows)  # noqa: E731
    handler = make_handler(adapter, make_button=make_button, make_markup=make_markup, ctx=_CTX)
    application.add_handler(CallbackQueryHandler(handler, pattern=HANDLER_PATTERN, block=False))
    logger.info("av-rate: rating card buttons wired (pattern %s)", HANDLER_PATTERN)

    async def pass_once(*_: Any) -> None:
        await pick_up(application.bot, adapter, make_button, make_markup, ctx=_CTX)

    job_queue = getattr(application, "job_queue", None)
    if job_queue is not None and callable(getattr(job_queue, "run_repeating", None)):
        try:
            job_queue.run_repeating(pass_once, interval=PICKUP_INTERVAL_S, first=5.0, name="av-rate-pickup")
            logger.info("av-rate: pick-up on the job queue every %ss", int(PICKUP_INTERVAL_S))
            return
        except Exception:  # noqa: BLE001 - fall through to the loop task
            logger.info("av-rate: job queue refused; using a loop task")

    async def loop() -> None:
        await asyncio.sleep(5.0)
        while True:
            await pass_once()
            await asyncio.sleep(PICKUP_INTERVAL_S)

    try:
        asyncio.get_running_loop().create_task(loop(), name="av-rate-pickup")
        logger.info("av-rate: pick-up on a loop task every %ss", int(PICKUP_INTERVAL_S))
    except RuntimeError:
        logger.warning("av-rate: no running loop at wire time; cards are sent on taps only")


def register(ctx: Any) -> None:
    """Hermes plugin entrypoint: one scoped Telegram callback handler and the pick-up. No tools."""
    global _CTX
    _CTX = ctx
    try:
        wire = getattr(ctx, "register_platform_handler", None)
        if callable(wire):
            wire("telegram", _wire_telegram)
            return
        legacy = getattr(ctx, "register_telegram_handler", None)
        if callable(legacy):
            legacy(_wire_telegram)
            return
        logger.warning("av-rate: this Hermes has no platform handler registration; cards are off")
    except Exception:  # noqa: BLE001
        logger.warning("av-rate: could not register the rating card handler", exc_info=True)


__all__ = [
    "CALLBACK_DATA_MAX_BYTES", "CARD_FIT", "CARD_PLANNED", "CHANNEL", "LABELS", "MANAGE_LINE", "PRIVACY_LINE", "SCALE",
    "WINDOW_HOURS", "asked_record", "cards_on", "fit_callback", "fit_rows", "fit_text", "hand_off", "hash_key",
    "injected_line", "is_owner_tap", "ledger_path", "load_ledger", "make_handler", "make_nonce", "mark_keyboard",
    "parse_callback", "pick_up", "planned_callback", "planned_record", "planned_rows", "planned_text", "rated_record",
    "record_tap", "register", "session_key_for", "stage_dir", "events_dir", "valid_stage",
]
