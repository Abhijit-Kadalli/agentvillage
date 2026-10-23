"""av-elicit: the box half of GC-ELICIT (the agent asks its human about ODIN's constitution).

Contract: GC-ELICIT v1, sections 1 (timing and gates), 3a (what the control plane writes), 3b (what this
plugin writes) and 3c (what the agent's tool writes). Everything lives under
``$HERMES_HOME/av-events/elicit/``:

  inject/<unix_ms>-<name>.txt   written by the control plane (``open``, ``next``, ``replan``). The first line
                                may be ``#trigger=<opener|answer|idle|human_message|replan>``; it is metadata,
                                stripped before injection, and read back for the tool's records.
  inject/<file>.done            this plugin: the gateway accepted the injection (rename; mtime = accept time).
  inject/<file>.skipped         this plugin: ``closed`` marker present, older than the 24 h age cap, or unusable.
  closed                        the control plane's empty marker: inject nothing, skip what is pending.
  probe.json                    this plugin, every 60 s while a window is open: human messages since T0.
  records/<unix_ms>-<id>.json   the ``elicitation_record`` tool, one per call, 0600.

The inject loop injects one file per pass, oldest first, as a user-role turn into the resident's DM session
(``agent:main:telegram:dm:<TELEGRAM_HOME_CHANNEL>``, or ``AV_ELICIT_SESSION_KEY``) through
``ctx.inject_message``. Hermes refuses unless ``plugins.entries.av-elicit.allow_gateway_injection: true`` and
the session exists, so the loop waits until ``state.db`` has a Telegram session under that key. Nothing is
injected between 22:00 and 08:00 IST (the file is held).

Fail-open: no hooks, one daemon thread, one tool; every failure is a log code, never an exception into the
gateway. Logs carry codes and counts only, never a message's text. Python 3.9+, standard library only.
"""
from __future__ import annotations

import json
import logging
import os
import re
import stat
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

logger = logging.getLogger("av-elicit")

# --------------------------------------------------------------------------- constants

TOOL_NAME = "elicitation_record"
TOOLSET = "av-elicit"

SESSION_KEY_ENV = "AV_ELICIT_SESSION_KEY"
HOME_CHANNEL_ENV = "TELEGRAM_HOME_CHANNEL"

#: Every control-plane notice starts with this (contract §5); the probe never counts such a row as human.
NOTICE_PREFIX = "[Agent Village notice"

POLL_S = 5.0
PROBE_INTERVAL_S = 60.0
#: A staged file older than this (by its unix_ms name prefix, else mtime) is skipped, never injected.
AGE_CAP_S = 24 * 3600
#: IST has no daylight saving: a fixed offset needs no tz database on the box.
IST = timezone(timedelta(hours=5, minutes=30))
QUIET_START_HOUR = 22
QUIET_END_HOUR = 8

INJECT_MAX_BYTES = 32 * 1024
TEXT_MAX = 4000
TAKEAWAY_MAX = 2000
QUESTION_NO_MAX = 100
STATEMENT_IDS_MAX = 64
#: Records a box may hold before the tool refuses (6 questions and their answers fit many times over).
RECORDS_MAX = 200

DIR_MODE = 0o700
FILE_MODE = 0o600

KINDS = ("question", "answer", "stop")
FORMS = ("open", "trade_off", "direct_rating", "other")
TRIGGERS = ("opener", "answer", "idle", "human_message", "replan")
NAMES = ("open", "next", "replan")
#: The trigger a file's name implies when its first line carries none (``next`` defaults to ``answer``).
NAME_TRIGGER = {"open": "opener", "next": "answer", "replan": "replan"}

SLUG = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
STATEMENT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
TRIGGER_LINE = re.compile(r"^#trigger=([a-z_]+)\s*$")
STAGE_NAME = re.compile(r"^(\d{10,16})-([a-z]+)$")

TOOL_DESCRIPTION = (
    "Record one step of the ODIN constitution conversation with your human: a question you sent them "
    "(kind question), their answer (kind answer: their words, what you learned, the statement ids it "
    "informed), or their 'not now' or 'stop' (kind stop). Call it every time you ask or they answer, and "
    "only while that conversation is open; it works only in your Telegram DM with your human."
)

TOOL_SCHEMA: dict = {
    "name": TOOL_NAME,
    "description": TOOL_DESCRIPTION,
    "parameters": {
        "type": "object",
        "properties": {
            "kind": {"type": "string", "enum": list(KINDS),
                     "description": "question (you asked), answer (they answered) or stop (they said not now or stop)."},
            "question_no": {"type": "integer", "minimum": 1,
                            "description": "The question's number in this conversation, 1 for the first; an answer "
                                           "or a stop uses the number of the question it answers."},
            "category": {"type": "string",
                         "description": "The category id the question or answer is about (e.g. privacy_and_consent)."},
            "form": {"type": "string", "enum": list(FORMS),
                     "description": "Question only: open, trade_off, direct_rating or other."},
            "text": {"type": "string",
                     "description": "Required for question and answer: the question exactly as you sent it, or "
                                    "their answer in their own words."},
            "takeaway": {"type": "string", "description": "Answer only: what you learned, in one or two sentences."},
            "statement_ids": {"type": "array", "items": {"type": "string"},
                              "description": "Answer only: the statement ids (e.g. s004) this answer informs."},
        },
        "required": ["kind", "question_no"],
        "additionalProperties": False,
    },
}

# --------------------------------------------------------------------------- state

_CTX: Any = None
_THREAD: Optional[threading.Thread] = None
_STOP = threading.Event()
_REGISTERED = False
_LAST_PROBE = 0.0
_LAST_CODE: Optional[str] = None
_RECORD_LOCK = threading.Lock()

# --------------------------------------------------------------------------- env, paths, logging


def hermes_home() -> str:
    return os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")


def _dotenv(home: str) -> dict:
    parsed: dict = {}
    try:
        with open(os.path.join(home, ".env"), encoding="utf-8-sig") as handle:
            for line in handle:
                line = line.strip()
                if line.startswith("export "):
                    line = line[7:].strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                name, _, value = line.partition("=")
                parsed[name.strip()] = value.strip().strip("'\"")
    except OSError:
        return {}
    return parsed


def env(name: str, home: Optional[str] = None) -> str:
    """The process environment (a present, blank value is authoritative), else ``$HERMES_HOME/.env``."""
    raw = os.environ.get(name)
    if raw is not None:
        return raw.strip()
    return str(_dotenv(home or hermes_home()).get(name, "")).strip()


def elicit_dir(home: Optional[str] = None) -> str:
    return os.path.join(home or hermes_home(), "av-events", "elicit")


def inject_dir(home: Optional[str] = None) -> str:
    return os.path.join(elicit_dir(home), "inject")


def records_dir(home: Optional[str] = None) -> str:
    return os.path.join(elicit_dir(home), "records")


def closed_path(home: Optional[str] = None) -> str:
    return os.path.join(elicit_dir(home), "closed")


def probe_path(home: Optional[str] = None) -> str:
    return os.path.join(elicit_dir(home), "probe.json")


def state_db(home: Optional[str] = None) -> str:
    return os.path.join(home or hermes_home(), "state.db")


def session_key(home: Optional[str] = None) -> Optional[str]:
    override = env(SESSION_KEY_ENV, home)
    if override:
        return override
    chat = env(HOME_CHANNEL_ENV, home)
    return f"agent:main:telegram:dm:{chat}" if chat else None


def _log(outcome: str, level: int = logging.INFO, **counts: Any) -> None:
    extra = "".join(f" {key}={value}" for key, value in sorted(counts.items()))
    logger.log(level, "av-elicit: outcome=%s%s", outcome, extra)


def _log_once(outcome: str, level: int = logging.INFO, **counts: Any) -> None:
    """Log a waiting state once until the state changes (the loop runs every few seconds)."""
    global _LAST_CODE
    if _LAST_CODE != outcome:
        _LAST_CODE = outcome
        _log(outcome, level, **counts)


def now_iso(epoch: Optional[float] = None) -> str:
    stamp = datetime.fromtimestamp(time.time() if epoch is None else epoch, tz=timezone.utc)
    return stamp.isoformat(timespec="milliseconds").replace("+00:00", "Z")


# --------------------------------------------------------------------------- quiet hours, ages, names


def in_quiet_hours(epoch: float) -> bool:
    """True from 22:00 to 08:00 Asia/Kolkata (contract §1): no injection, the file is held."""
    hour = datetime.fromtimestamp(epoch, tz=IST).hour
    return hour >= QUIET_START_HOUR or hour < QUIET_END_HOUR


def parse_stage_name(filename: str) -> Optional[tuple]:
    """``<unix_ms>-<name>.<ext>`` -> ``(unix_ms, name)``, or None for anything else."""
    stem = filename.rsplit(".", 1)[0] if "." in filename else filename
    match = STAGE_NAME.match(stem)
    if not match:
        return None
    return int(match.group(1)), match.group(2)


def staged_at(path: str) -> Optional[float]:
    """Seconds since the epoch the file was staged: its name's unix_ms, else its mtime."""
    parsed = parse_stage_name(os.path.basename(path))
    if parsed:
        return parsed[0] / 1000.0
    try:
        return os.stat(path).st_mtime
    except OSError:
        return None


def split_trigger(raw: str) -> tuple:
    """``(trigger_or_None, text)``: a ``#trigger=`` first line is removed from the text to inject."""
    first, _, rest = raw.partition("\n")
    match = TRIGGER_LINE.match(first.strip("\r"))
    if not match:
        return None, raw
    value = match.group(1)
    return (value if value in TRIGGERS else None), rest.lstrip("\r\n")


def trigger_for(filename: str, first_line_trigger: Optional[str]) -> Optional[str]:
    """The record's trigger for the last injected file: its ``#trigger=`` line, else its name's default."""
    if first_line_trigger in TRIGGERS:
        return first_line_trigger
    parsed = parse_stage_name(filename)
    return NAME_TRIGGER.get(parsed[1]) if parsed else None


# --------------------------------------------------------------------------- files


def _listing(directory: str, suffix: str) -> list:
    """Names in ``directory`` ending in ``suffix``, sorted (unix_ms names sort by staging time)."""
    try:
        return sorted(n for n in os.listdir(directory) if n.endswith(suffix) and not n.startswith("."))
    except OSError:
        return []


def _read_regular(path: str, max_bytes: int) -> tuple:
    """``(text, None)`` or ``(None, code)``: a regular file, never through a symlink, bounded."""
    try:
        st = os.lstat(path)
    except OSError:
        return None, "missing"
    if not stat.S_ISREG(st.st_mode):
        return None, "not_regular"
    if st.st_size > max_bytes:
        return None, "too_big"
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd, "rb") as handle:
            raw = handle.read(max_bytes + 1)
    except OSError:
        return None, "unreadable"
    if len(raw) > max_bytes:
        return None, "too_big"
    try:
        return raw.decode("utf-8"), None
    except UnicodeDecodeError:
        return None, "not_utf8"


def _rename_now(path: str, suffix: str) -> Optional[str]:
    """Rename ``x.txt`` to ``x<suffix>`` and stamp its mtime now: the control plane reads the rename time
    as ``delivered_at`` (a rename alone keeps the staging mtime). Returns the new path, or None."""
    target = (path[: -len(".txt")] if path.endswith(".txt") else path) + suffix
    try:
        os.rename(path, target)
    except OSError:
        return None
    try:
        os.utime(target, None)
    except OSError:
        pass
    return target


def write_private_json(path: str, data: Any) -> None:
    """By temp file and rename, 0600 in a 0700 directory; the temp name starts with a dot and never ends in
    ``.json``, so a reader listing ``*.json`` never sees a half-written file. Raises OSError."""
    directory = os.path.dirname(path)
    os.makedirs(directory, mode=DIR_MODE, exist_ok=True)
    tmp = os.path.join(directory, f".{os.path.basename(path)}.{os.getpid()}.{threading.get_ident()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0), FILE_MODE)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, separators=(",", ":"), ensure_ascii=False)
        os.chmod(tmp, FILE_MODE)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def is_closed(home: Optional[str] = None) -> bool:
    return os.path.lexists(closed_path(home))


def open_done_times(home: Optional[str] = None) -> list:
    """Accept times (mtime, seconds) of every ``*-open.done``, oldest first."""
    directory = inject_dir(home)
    times = []
    for name in _listing(directory, ".done"):
        parsed = parse_stage_name(name)
        if not parsed or parsed[1] != "open":
            continue
        try:
            times.append(os.stat(os.path.join(directory, name)).st_mtime)
        except OSError:
            continue
    return sorted(times)


def window_open(home: Optional[str] = None) -> bool:
    """A window is open while an ``open`` notice has been injected and no ``closed`` marker exists."""
    return not is_closed(home) and bool(open_done_times(home))


def last_injected(home: Optional[str] = None) -> Optional[str]:
    """The ``.done`` file accepted last (by mtime, then name), or None."""
    directory = inject_dir(home)
    best: Optional[tuple] = None
    for name in _listing(directory, ".done"):
        try:
            key = (os.stat(os.path.join(directory, name)).st_mtime, name)
        except OSError:
            continue
        if best is None or key > best:
            best = key
    return os.path.join(directory, best[1]) if best else None


def current_trigger(home: Optional[str] = None) -> Optional[str]:
    """The trigger of the notice injected last: what a question recorded now answers to."""
    path = last_injected(home)
    if not path:
        return None
    text, _ = _read_regular(path, INJECT_MAX_BYTES)
    first = split_trigger(text)[0] if text is not None else None
    return trigger_for(os.path.basename(path), first)


# --------------------------------------------------------------------------- state.db (read-only)


def _sqlite_rows(path: str, sql: str, params: tuple = ()) -> Optional[list]:
    """Rows from a Hermes store opened read-only, or None on any failure (missing file, table, lock)."""
    if not os.path.isfile(path):
        return None
    import sqlite3
    import urllib.parse

    conn = None
    try:
        conn = sqlite3.connect("file:" + urllib.parse.quote(os.path.abspath(path)) + "?mode=ro", uri=True, timeout=2)
        return conn.execute(sql, params).fetchall()
    except sqlite3.Error:
        return None
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass


def dm_session_exists(key: str, home: Optional[str] = None) -> bool:
    """True when state.db holds a Telegram session under this key (the gateway injects only into a session
    it can look up; one appears after the human's first message to the bot)."""
    rows = _sqlite_rows(state_db(home), "SELECT 1 FROM sessions WHERE source='telegram' AND session_key=? LIMIT 1", (key,))
    return bool(rows)


def human_messages_since(since_s: float, home: Optional[str] = None) -> Optional[tuple]:
    """``(count, last_ms_or_None)`` of human user-role messages in Telegram sessions at or after ``since_s``,
    notice-prefixed rows excluded; None when state.db cannot be read."""
    rows = _sqlite_rows(
        state_db(home),
        "SELECT COUNT(*), MAX(m.timestamp) FROM messages m JOIN sessions s ON s.id = m.session_id "
        "WHERE s.source = 'telegram' AND m.role = 'user' AND m.timestamp >= ? "
        "AND (m.content IS NULL OR substr(m.content, 1, ?) <> ?)",
        (float(since_s), len(NOTICE_PREFIX), NOTICE_PREFIX),
    )
    if not rows:
        return None
    count, last = rows[0]
    return int(count or 0), (int(round(float(last) * 1000)) if last is not None else None)


def telegram_dm_session(session_id: Any, home: Optional[str] = None) -> bool:
    """True when ``session_id`` is a Telegram DM session, and the resident's own DM when the home key is known."""
    sid = str(session_id or "").strip()
    if not sid:
        return False
    rows = _sqlite_rows(state_db(home), "SELECT source, chat_type, session_key FROM sessions WHERE id=? LIMIT 1", (sid,))
    if not rows:
        return False
    source, chat_type, key = rows[0]
    if source != "telegram" or chat_type != "dm":
        return False
    home_key = session_key(home)
    return home_key is None or key == home_key


# --------------------------------------------------------------------------- the inject pass


def inject_pass(ctx: Any = None, home: Optional[str] = None, now: Optional[float] = None) -> str:
    """One pass: skip everything pending when closed, skip files past the age cap, else inject the oldest
    file (at most one per pass). Returns an outcome code."""
    global _LAST_CODE
    stamp = time.time() if now is None else now
    directory = inject_dir(home)
    pending = _listing(directory, ".txt")
    if not pending:
        return "idle"
    if is_closed(home):
        skipped = sum(1 for n in pending if _rename_now(os.path.join(directory, n), ".skipped"))
        _log("skipped_closed", skipped=skipped)
        return "skipped_closed"
    fresh = []
    aged = 0
    for name in pending:
        path = os.path.join(directory, name)
        at = staged_at(path)
        if at is not None and stamp - at > AGE_CAP_S:
            aged += 1 if _rename_now(path, ".skipped") else 0
        else:
            fresh.append(name)
    if aged:
        _log("skipped_aged", skipped=aged)
    if not fresh:
        return "skipped_aged"
    if in_quiet_hours(stamp):
        _log_once("held_quiet_hours", pending=len(fresh))
        return "held_quiet_hours"
    key = session_key(home)
    if not key:
        _log_once("no_session_key", logging.WARNING)
        return "no_session_key"
    if not dm_session_exists(key, home):
        _log_once("waiting_dm_session", pending=len(fresh))
        return "waiting_dm_session"
    path = os.path.join(directory, fresh[0])
    raw, code = _read_regular(path, INJECT_MAX_BYTES)
    if raw is None:
        _rename_now(path, ".skipped")
        _log("skipped_unusable", logging.WARNING, reason=code)
        return "skipped_unusable"
    _, text = split_trigger(raw)
    if not text.strip():
        _rename_now(path, ".skipped")
        _log("skipped_unusable", logging.WARNING, reason="empty")
        return "skipped_unusable"
    context = ctx if ctx is not None else _CTX
    inject_fn = getattr(context, "inject_message", None)
    if not callable(inject_fn):
        _log_once("inject_no_ctx", logging.WARNING)
        return "inject_no_ctx"
    try:
        accepted = bool(inject_fn(text, session_key=key))
    except Exception as exc:  # noqa: BLE001
        _log_once("inject_error", logging.WARNING, error=type(exc).__name__)
        return "inject_error"
    if not accepted:
        # Hermes said no: the config flag is off, no live gateway, or no session yet. Retried next pass.
        _log_once("inject_refused", logging.WARNING, pending=len(fresh))
        return "inject_refused"
    _rename_now(path, ".done")
    parsed = parse_stage_name(fresh[0])
    _log("injected", name=parsed[1] if parsed and parsed[1] in NAMES else "other", pending=len(fresh) - 1)
    _LAST_CODE = None
    return "injected"


# --------------------------------------------------------------------------- the probe


def probe_payload(home: Optional[str] = None) -> Optional[dict]:
    """``probe.json``'s body (contract 3b), or None when no window is open or state.db is unreadable."""
    if is_closed(home):
        return None
    times = open_done_times(home)
    if not times:
        return None
    since = times[0]
    counted = human_messages_since(since, home)
    if counted is None:
        return None
    count, last = counted
    return {"human_messages_since": int(round(since * 1000)), "count": count, "last_human_at": last}


def probe_pass(home: Optional[str] = None, now: Optional[float] = None, force: bool = False) -> str:
    """Rewrite ``probe.json`` at most every 60 s while a window is open. Returns a code."""
    global _LAST_PROBE
    stamp = time.time() if now is None else now
    if not force and stamp - _LAST_PROBE < PROBE_INTERVAL_S:
        return "probe_not_due"
    directory = inject_dir(home)
    if not (_listing(directory, ".txt") or _listing(directory, ".done")):
        return "probe_no_files"
    payload = probe_payload(home)
    if payload is None:
        return "probe_no_window"
    try:
        write_private_json(probe_path(home), payload)
    except OSError as exc:
        _log_once("probe_write_failed", logging.WARNING, error=type(exc).__name__)
        return "probe_write_failed"
    _LAST_PROBE = stamp
    return "probe_written"


# --------------------------------------------------------------------------- the tool


class Refused(ValueError):
    """A record the tool will not write; ``code`` is what is logged, ``str()`` what the agent reads."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _opt_str(args: dict, name: str, limit: int) -> Optional[str]:
    value = args.get(name)
    if value is None:
        return None
    if not isinstance(value, str):
        raise Refused("bad_" + name, f"{name} must be a string.")
    value = value.strip()
    if not value:
        return None
    if len(value) > limit:
        raise Refused("long_" + name, f"{name} is longer than {limit} characters; shorten it.")
    return value


def validate_record(args: Any) -> dict:
    """The agent's arguments -> the record's agent-supplied fields. Raises Refused."""
    if not isinstance(args, dict):
        raise Refused("bad_args", "Arguments must be an object.")
    kind = args.get("kind")
    if kind not in KINDS:
        raise Refused("bad_kind", "kind must be question, answer or stop.")
    number = args.get("question_no")
    if isinstance(number, float) and number.is_integer():
        number = int(number)
    if isinstance(number, bool) or not isinstance(number, int) or not 1 <= number <= QUESTION_NO_MAX:
        raise Refused("bad_question_no", f"question_no must be a whole number from 1 to {QUESTION_NO_MAX}.")
    category = _opt_str(args, "category", 64)
    if category is not None and not SLUG.match(category):
        raise Refused("bad_category", "category must be a category id such as privacy_and_consent.")
    form = _opt_str(args, "form", 32)
    if form is not None and form not in FORMS:
        raise Refused("bad_form", "form must be open, trade_off, direct_rating or other.")
    text = _opt_str(args, "text", TEXT_MAX)
    if kind in ("question", "answer") and text is None:
        raise Refused("missing_text", f"text is required for kind {kind}.")
    takeaway = _opt_str(args, "takeaway", TAKEAWAY_MAX)
    raw_ids = args.get("statement_ids")
    ids: list = []
    if raw_ids is not None:
        if not isinstance(raw_ids, list) or len(raw_ids) > STATEMENT_IDS_MAX:
            raise Refused("bad_statement_ids", f"statement_ids must be a list of at most {STATEMENT_IDS_MAX} ids.")
        for item in raw_ids:
            if not isinstance(item, str) or not STATEMENT_ID.match(item.strip()):
                raise Refused("bad_statement_ids", "statement_ids must be statement ids such as s004.")
            if item.strip() not in ids:
                ids.append(item.strip())
    return {
        "kind": kind,
        "question_no": number,
        "category": category,
        # Question only; a question without a form is "other" (the app's column is the closed enum).
        "form": (form or "other") if kind == "question" else None,
        "text": text,
        "takeaway": takeaway if kind == "answer" else None,
        "statement_ids": ids if kind == "answer" else [],
    }


def build_record(fields: dict, trigger: Optional[str], now: Optional[float] = None,
                 record_id: Optional[str] = None) -> dict:
    """The full 3c record: ``record_id`` uuid4, ``trigger`` from the plugin (question only), ``recorded_at`` now."""
    return {
        "record_id": record_id or str(uuid.uuid4()),
        "kind": fields["kind"],
        "question_no": fields["question_no"],
        "category": fields["category"],
        "form": fields["form"],
        "trigger": trigger if fields["kind"] == "question" else None,
        "text": fields["text"],
        "takeaway": fields["takeaway"],
        "statement_ids": fields["statement_ids"],
        "recorded_at": now_iso(now),
    }


def confirmation(record: dict) -> str:
    where = f" ({record['category']})" if record.get("category") else ""
    if record["kind"] == "question":
        return f"Recorded question {record['question_no']}{where}."
    if record["kind"] == "answer":
        n = len(record["statement_ids"])
        return f"Recorded the answer to question {record['question_no']}{where}, informing {n} statement(s)."
    return "Recorded stop: send a one-line thanks and ask nothing more about the constitution."


def record_elicitation(args: Any, session_id: Any, home: Optional[str] = None, now: Optional[float] = None) -> str:
    """Gate, validate and write one record. Returns the line the agent reads; raises Refused."""
    if not telegram_dm_session(session_id, home):
        raise Refused("not_dm", "elicitation_record works only in your Telegram DM with your human.")
    if not window_open(home):
        raise Refused("no_window", "No ODIN constitution conversation is open; nothing was recorded.")
    fields = validate_record(args)
    stamp = time.time() if now is None else now
    record = build_record(fields, current_trigger(home), stamp)
    directory = records_dir(home)
    with _RECORD_LOCK:
        if len(_listing(directory, ".json")) >= RECORDS_MAX:
            raise Refused("records_full", "This conversation already holds the most records allowed.")
        path = os.path.join(directory, f"{int(stamp * 1000)}-{record['record_id']}.json")
        try:
            write_private_json(path, record)
        except OSError as exc:
            raise Refused("write_failed", "Could not record that right now; try once more.") from exc
    _log("recorded", kind=record["kind"], question_no=record["question_no"], statements=len(record["statement_ids"]))
    return confirmation(record)


def elicitation_record_tool(args: Any = None, **kwargs: Any) -> str:
    """The Hermes handler: a one-line confirmation, or ``{"error": ...}``. Never raises."""
    try:
        return record_elicitation(args, kwargs.get("session_id"))
    except Refused as refused:
        _log("refused", reason=refused.code)
        return json.dumps({"error": str(refused)})
    except Exception as exc:  # noqa: BLE001 - fail open
        try:
            _log("record_error", logging.WARNING, error=type(exc).__name__)
        except Exception:  # noqa: BLE001
            pass
        return json.dumps({"error": "Could not record that right now; try once more."})


# --------------------------------------------------------------------------- loop and registration


def run_once(ctx: Any = None, home: Optional[str] = None, now: Optional[float] = None) -> tuple:
    """One loop iteration: the inject pass, then the probe. Never raises; returns both codes."""
    try:
        injected = inject_pass(ctx, home, now)
    except Exception as exc:  # noqa: BLE001
        injected = "pass_failed"
        _log_once("pass_failed", logging.WARNING, error=type(exc).__name__)
    try:
        probed = probe_pass(home, now)
    except Exception as exc:  # noqa: BLE001
        probed = "probe_failed"
        _log_once("probe_failed", logging.WARNING, error=type(exc).__name__)
    return injected, probed


def _loop() -> None:
    while not _STOP.is_set():
        run_once()
        _STOP.wait(POLL_S)


def _on_unload() -> None:
    global _REGISTERED
    _STOP.set()
    _REGISTERED = False


def register_record_tool(ctx: Any) -> bool:
    """Register ``elicitation_record``; a Hermes without plugin tools gets one log line and no tool."""
    register_tool = getattr(ctx, "register_tool", None)
    if not callable(register_tool):
        _log("tool_skipped", reason="no_register_tool")
        return False
    try:
        try:
            register_tool(name=TOOL_NAME, toolset=TOOLSET, schema=TOOL_SCHEMA, handler=elicitation_record_tool,
                          description=TOOL_DESCRIPTION)
        except TypeError:
            # An older register_tool without `description`.
            register_tool(name=TOOL_NAME, toolset=TOOLSET, schema=TOOL_SCHEMA, handler=elicitation_record_tool)
    except Exception as exc:  # noqa: BLE001 - the tool must never cost the loop
        _log("tool_register_failed", logging.WARNING, error=type(exc).__name__)
        return False
    return True


def register(ctx: Any) -> None:
    """Hermes entrypoint (synchronous): the tool and the inject/probe thread. Idempotent; never raises."""
    global _CTX, _THREAD, _REGISTERED
    _CTX = ctx
    if _REGISTERED:
        return
    try:
        register_record_tool(ctx)
        try:
            os.makedirs(inject_dir(), mode=DIR_MODE, exist_ok=True)
        except OSError:
            pass
        _STOP.clear()
        if _THREAD is None or not _THREAD.is_alive():
            _THREAD = threading.Thread(target=_loop, name="av-elicit", daemon=True)
            _THREAD.start()
        on_unload = getattr(ctx, "on_unload", None)
        if callable(on_unload):
            try:
                on_unload(_on_unload)
            except Exception:  # noqa: BLE001
                pass
        _REGISTERED = True
        _log("registered")
    except Exception as exc:  # noqa: BLE001
        _log("register_failed", logging.WARNING, error=type(exc).__name__)


__all__ = [
    "AGE_CAP_S", "FORMS", "KINDS", "NOTICE_PREFIX", "TOOL_NAME", "TOOL_SCHEMA", "TRIGGERS", "Refused",
    "build_record", "closed_path", "confirmation", "current_trigger", "dm_session_exists", "elicitation_record_tool",
    "human_messages_since", "in_quiet_hours", "inject_dir", "inject_pass", "is_closed", "last_injected",
    "open_done_times", "parse_stage_name", "probe_pass", "probe_path", "probe_payload", "record_elicitation",
    "records_dir", "register", "register_record_tool", "run_once", "session_key", "split_trigger",
    "telegram_dm_session", "trigger_for", "validate_record", "window_open",
]
