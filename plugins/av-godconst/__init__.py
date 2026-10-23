"""av-godconst: the resident's God Constitution ballot as Telegram button cards (GC-TELEGRAM-BALLOT).

Design: docs/GODCONST-TELEGRAM-BALLOT.md. The resident's own bot sends the statements of the open rating pool in the
resident's own order (the app's), PAGE_SIZE at a time (a pair: with the app's godconst-order-v2, one agent-written and
one ODIN-written statement, in a random inside order per resident), each with five buttons 1..5. A tap is a rating
saved on the SAME ballot the /constitution page shows; the next pair arrives once the current one is rated; a re-tap
is a revision; "rate as many as you can" (unrated = no opinion).

**The data path.** The box never reaches the app and holds no app credential. It calls its control plane with its
own ballot key (``CONTROL_PLANE_URL`` pinned to ``CP_HOSTS``, ``Authorization: Bearer $AV_GODCONST_BALLOT_KEY``, a
per-tenant credential custody keeps from every agent-run child; the ask-village wire otherwise): ``POST /tenants/<own tenant>/godconst/ballot`` (read) and ``.../ballot/rate`` (one tap). The control
plane authenticates the key against this tenant, checks its switches and research consent, and forwards with the
GODCONST bridge key and the authenticated tenant id; the app maps that tenant to its one resident and applies every
GODCONST rule (cohort, take-part consent, pool phase, order, ballot) on every call. So every send follows a fresh read
and every tap is re-checked end to end.

**Nothing private on disk.** Statement texts and rating values pass through memory on their way to Telegram and are
never written: the ledger (``$HERMES_HOME/av-godconst/ballot.json``, 0600 in a 0700 directory) holds the pool id and
hash, the order's statement ids, message ids and the positions known rated; no value and no derivative of one (the
check a card shows is kept in memory only, ``_SHOWN``). When the ballot ends here (submitted, closed, the window over,
withdrawn), the session is deleted and only a tombstone stays (the pool hash, the nonce and the ending), so a later
tap answers why it no longer saves. Nothing is
injected into the agent's session and the agent's tools never see a card or a tap (the Bot API's own sends are not
updates, and the ``^gcb:`` handler answers every tap before Hermes's core): the experiment's agent ballots and
snapshots stay blind to the resident's ratings.

**Wiring** (Hermes v2026.9.24, av-vote's and av-rate's): ``ctx.register_platform_handler("telegram", factory)``; one
``CallbackQueryHandler`` scoped to ``^gcb:`` with ``block=False``; a pass every ``PASS_INTERVAL_S`` on PTB's job queue,
else an asyncio task. The pass reads (at most every ``POLL_ACTIVE_S`` while a ballot is open on this box, else every
``POLL_IDLE_S``) and then starts, advances, re-marks or ends the cards.

**Taps**: owner only (the box's own resident in their own DM: av-vote's rule); the card's session nonce must be the
ledger's; the save goes to the control plane; the answer is "Saved: <label>", the card's tapped button is marked, and
a page fully rated sends the next one. A failed save answers a short reason and leaves the card as it is.

**Switch.** ``AV_GODCONST_BALLOT`` (``1|true|yes|on``; process environment, else ``$HERMES_HOME/.env``), written by the
control plane from ``GODCONST_BALLOT_TENANTS``. Off: nothing is read or sent; taps still answer (the control plane is
the authority and refuses when the route is off). Logs: ``av-godconst: tenant=<id8> outcome=<code> [k=v]``, codes and
counts only; never a statement, a text, a rating, a user id, a key or callback data.

Python 3.11, standard library only; the Telegram SDK is imported inside the factory.
"""

from __future__ import annotations

import asyncio
import http.client
import json
import logging
import os
import re
import secrets
import stat
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import warnings
from typing import Any, Callable, Optional

try:
    from . import _logic as L
except ImportError:  # loaded by path without a package (a local run)
    import importlib.util as _ilu

    _spec = _ilu.spec_from_file_location("av_godconst_logic", os.path.join(os.path.dirname(os.path.abspath(__file__)), "_logic.py"))
    L = _ilu.module_from_spec(_spec)  # type: ignore[arg-type]
    _spec.loader.exec_module(L)  # type: ignore[union-attr]

logger = logging.getLogger(__name__)

PLUGIN_ID = "av-godconst"
ON_SWITCH = "AV_GODCONST_BALLOT"
URL_ENV = "CONTROL_PLANE_URL"
#: The per-tenant ballot credential the control plane writes (godconst-ballot-key.js). Never EDGEOS_API_KEY: the agent
#: can read that one. av-approval custody strips this name from every agent-run child (custody_keys.json, FLOOR), so
#: only this plugin, inside the gateway, holds it.
CREDENTIAL_ENV = "AV_GODCONST_BALLOT_KEY"
HOME_CHANNEL_ENV = "TELEGRAM_HOME_CHANNEL"
TENANT_ENVS = ("AV_TENANT_ID", "TENANT_ID")
TRUTHY = frozenset({"1", "true", "yes", "on"})
#: av-events _pray.CP_HOSTS (directory.ts): the only hosts the ballot key is sent to over https.
CP_HOSTS = frozenset({"control-plane-production-606c.up.railway.app"})
LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
READ_PATH = "/tenants/{tenant}/godconst/ballot"
RATE_PATH = "/tenants/{tenant}/godconst/ballot/rate"
HTTP_TIMEOUT_S = 12.0
RESPONSE_MAX_BYTES = 2 * 1024 * 1024

PASS_INTERVAL_S = 60.0
#: How often the pass reads while a ballot is open here (web changes, the close) and otherwise (a pool opening).
POLL_ACTIVE_S = 300.0
POLL_IDLE_S = 600.0
#: A card whose send keeps failing (bot blocked, chat gone) stops the session after this many passes in a row.
SEND_FAILURES_MAX = 3
#: Re-marks (a web change shown on a sent card) per pass at most.
REMARKS_PER_PASS = 10
SEND_GAP_S = 0.35
LEDGER_MAX_BYTES = 256 * 1024
DIR_MODE = 0o700
FILE_MODE = 0o600
ANSWER_MAX = 200
_TELEGRAM_USER = re.compile(r"[1-9][0-9]{0,19}")
_TENANT = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

#: Session statuses. `active`: cards go out; `stopped`: the resident pressed Stop (taps still save); the rest are final
#: for this pool: `done` (every page sent and the last line too), `submitted`, `closed`, `withdrawn`, `undeliverable`.
ACTIVE, STOPPED = "active", "stopped"
FINAL = frozenset({"done", "submitted", "closed", "withdrawn", "undeliverable"})
#: The endings that delete the session (a tombstone stays): nothing about this ballot is kept on the box after them.
ENDINGS = frozenset({"submitted", "closed", "withdrawn"})

NOT_YOURS = "This card is not yours"
BAD_BUTTON = "This button is not valid."
OLD_CARD = "This card is from an earlier ballot."
IN_FLIGHT = "Still saving..."
CLOSED = "Rating has closed."
SUBMITTED = "Your ballot is submitted, so rating is closed for you."
WITHDRAWN = "You can't take part right now."
OFF = "Rating by Telegram is off right now. You can still rate on the Constitution page."
FAILED = "Could not save that. Tap again, or use the Constitution page."
REFUSAL_TEXT = {
    "submitted": SUBMITTED, "pool_not_rating": CLOSED, "stale_pool": CLOSED, "closed": CLOSED,
    "consent_withdrawn": WITHDRAWN, "research_grant_required": WITHDRAWN, "research_consent_required": WITHDRAWN,
    "not_enabled": OFF, "not_found": WITHDRAWN, "unauthorized": OFF,
}
#: The refusal codes that end this box's session for the pool, and how.
REFUSAL_STATUS = {
    "submitted": "submitted", "pool_not_rating": "closed", "stale_pool": "closed",
    "consent_withdrawn": "withdrawn", "research_grant_required": "withdrawn", "research_consent_required": "withdrawn",
    # The app's own 404 (no longer admitted: removed from the cohort, the setup gone); never the control plane's
    # not_enabled (a switch, which can come back).
    "not_found": "withdrawn",
}
ENDED_TEXT = {"submitted": SUBMITTED, "closed": CLOSED, "withdrawn": WITHDRAWN}

_LEDGER_LOCK = threading.RLock()
_SEND_LOCK: Optional[asyncio.Lock] = None
_in_flight: set = set()
_last_read = {"at": 0.0}
#: (nonce, position) -> the value the card's check shows. Memory only: a restart forgets it and re-marks from the app.
_SHOWN: dict = {}


# --------------------------------------------------------------------------- env, paths, logging


def hermes_home() -> str:
    return os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")


def _dotenv(home: str) -> dict:
    parsed: dict = {}
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


def ballot_on(home: Optional[str] = None) -> bool:
    return env(ON_SWITCH, home).lower() in TRUTHY


def state_dir(home: Optional[str] = None) -> str:
    return os.path.join(home or hermes_home(), "av-godconst")


def ledger_path(home: Optional[str] = None) -> str:
    return os.path.join(state_dir(home), "ballot.json")


def page_open_path(home: Optional[str] = None) -> str:
    """GC-ELICIT coexistence: the empty marker av-elicit (overlay #478) reads to hold its opener while a page is open."""
    return os.path.join(home or hermes_home(), "av-events", "godconst", "page-open")


def page_is_open(session: Optional[dict], now: float) -> bool:
    """A sent page with an unrated card, cards active, inside the window."""
    if not isinstance(session, dict) or session.get("status") != ACTIVE or int(session.get("page", -1)) < 0:
        return False
    closes = L.epoch_from_iso(session.get("closes_at")) if session.get("closes_at") else None
    if closes is not None and now >= closes:
        return False
    rated = set(session.get("rated", []))
    sent = {int(p) for p in session.get("cards", {})}
    return any(p in sent and p not in rated for p in L.page_positions(int(session["page"]), len(session["order"])))


def set_page_open(is_open: bool, home: Optional[str] = None, touch: bool = False) -> None:
    """Create (empty, 0600, in a 0700 directory) or remove the marker; `touch` refreshes its mtime (each page sent: the
    av-elicit plugin ignores a marker older than 12 h, so a page left open long ago never holds the opener). Never
    raises."""
    path = page_open_path(home)
    try:
        if is_open:
            if not os.path.lexists(path):
                os.makedirs(os.path.dirname(path), mode=DIR_MODE, exist_ok=True)
                os.close(os.open(path, os.O_WRONLY | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), FILE_MODE))
            elif touch:
                os.utime(path, None, follow_symlinks=False)
        elif os.path.lexists(path):
            os.unlink(path)
    except OSError:
        _log("page_marker_unwritable")


def reconcile_page_open(home: Optional[str] = None, now: Optional[float] = None) -> bool:
    """At plugin start: keep the marker only while the ledger shows an open page inside the window (a crash or a
    restart never leaves it stale). True when it is kept."""
    with _LEDGER_LOCK:
        ledger, why = load_ledger(home)
    keep = why is None and page_is_open(ledger.get("session"), time.time() if now is None else now)
    set_page_open(keep, home)
    return keep


def tenant_id(home: Optional[str] = None) -> Optional[str]:
    for name in TENANT_ENVS:
        value = env(name, home).lower()
        if _TENANT.fullmatch(value):
            return value
    return None


def tenant_id8() -> str:
    for name in TENANT_ENVS:
        value = os.environ.get(name, "").strip()
        if value:
            return re.sub(r"[^A-Za-z0-9-]", "", value)[:8]
    return "-"


def _log(outcome: str, **counts: Any) -> None:
    extra = "".join(f" {key}={value}" for key, value in sorted(counts.items()))
    logger.info("av-godconst: tenant=%s outcome=%s%s", tenant_id8(), outcome, extra)


def now_iso(epoch: Optional[float] = None) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() if epoch is None else epoch))


# --------------------------------------------------------------------------- private files


def _uid() -> Optional[int]:
    return os.getuid() if hasattr(os, "getuid") else None


def _private_dir(path: str) -> bool:
    try:
        st = os.lstat(path)
    except OSError:
        return False
    uid = _uid()
    return stat.S_ISDIR(st.st_mode) and (uid is None or st.st_uid == uid) and not st.st_mode & 0o077


def _read_private(path: str, max_bytes: int) -> tuple:
    """`(data, None)` or `(None, code)`: missing, bad_dir, not_regular, foreign_owner, not_private, too_big, unreadable."""
    if not os.path.lexists(path):
        return None, "missing"
    if not _private_dir(os.path.dirname(path)):
        return None, "bad_dir"
    try:
        st = os.lstat(path)
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
            return json.loads(handle.read(max_bytes + 1)), None
    except (OSError, ValueError):
        return None, "unreadable"


def _write_private(path: str, data: Any) -> None:
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


# --------------------------------------------------------------------------- the ledger


def empty_ledger() -> dict:
    return {"v": 1, "session": None}


def load_ledger(home: Optional[str] = None) -> tuple:
    """`(ledger, None)`; `(empty, "missing")` when there is none yet; `(empty, code)` when it cannot be trusted (then
    nothing is written over it and nothing is sent)."""
    data, why = _read_private(ledger_path(home), LEDGER_MAX_BYTES)
    if why is not None:
        return empty_ledger(), why
    if not isinstance(data, dict) or data.get("v") != 1 or not (data.get("session") is None or isinstance(data.get("session"), dict)):
        return empty_ledger(), "bad_shape"
    return data, None


def save_ledger(ledger: dict, home: Optional[str] = None) -> None:
    _write_private(ledger_path(home), ledger)


def end_session(ledger: dict, status: str, home: Optional[str] = None, now: Optional[float] = None) -> bool:
    """Delete the session (order, cards, rated positions) and keep a tombstone: the pool hash, the nonce and the ending.
    True when there was a session to end. The caller holds no lock; this takes it."""
    session = ledger.get("session")
    if not isinstance(session, dict):
        return False
    for key in [k for k in _SHOWN if k[0] == session.get("nonce")]:
        _SHOWN.pop(key, None)
    ledger.clear()
    ledger.update({"v": 1, "session": None, "ended": {"pool_sha256": session.get("pool_sha256"), "nonce": session.get("nonce"),
                                                      "status": status, "at": now_iso(now)}})
    with _LEDGER_LOCK:
        save_ledger(ledger, home)
    set_page_open(False, home)
    _log("ended", status=status)
    return True


def ended_for(ledger: dict, nonce: Optional[str] = None, pool_sha256: Optional[str] = None) -> Optional[str]:
    """The ending recorded for this nonce (a tap) or this pool (a read), else None."""
    ended = ledger.get("ended")
    if not isinstance(ended, dict):
        return None
    if nonce is not None and ended.get("nonce") == nonce or pool_sha256 is not None and ended.get("pool_sha256") == pool_sha256:
        status = ended.get("status")
        return status if status in ENDINGS else None
    return None


def new_session(view: dict, now: float) -> dict:
    """A session for the view's pool: ids and positions only (never a text or a value)."""
    pool = view["pool"]
    return {
        "pool_id": pool["id"], "pool_sha256": pool["sha256"], "order_rule": pool["order_rule"],
        "nonce": secrets.token_urlsafe(6)[: L.NONCE_CHARS].replace("=", "A"),
        "order": [s["id"] for s in view["statements"]], "closes_at": pool["closes_at"],
        "status": ACTIVE, "started_at": now_iso(now), "header_message_id": None,
        "page": -1, "cards": {}, "rated": [], "final_sent": False, "send_failures": 0,
    }


# --------------------------------------------------------------------------- the control plane


def cp_origin(raw: str) -> Optional[str]:
    """av-events _pray.cp_origin: https on a CP_HOSTS host (port 443), no userinfo, path, query or fragment; plain http
    only to a loopback host (tests, local runs)."""
    if not raw or "?" in raw or "#" in raw or any(ord(ch) <= 0x20 or ord(ch) == 0x7F for ch in raw):
        return None
    try:
        parts = urllib.parse.urlsplit(raw)
        host = (parts.hostname or "").lower()
        port = parts.port
    except ValueError:
        return None
    if not host or parts.username is not None or parts.password is not None or parts.path not in ("", "/"):
        return None
    if parts.scheme == "https" and host in CP_HOSTS and port in (None, 443):
        return f"https://{host}"
    if parts.scheme == "http" and host in LOOPBACK_HOSTS:
        return f"http://{parts.netloc}"
    return None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:  # noqa: D401 - never follow
        return None


_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect)


class Reply:
    """`status` and `data` when the control plane answered; `code` is the answer's closed code (`state` on a 200,
    `error` on a refusal) or a transport failure (`not_configured`, `network`, `timeout`, `bad_response`)."""

    __slots__ = ("status", "data", "code")

    def __init__(self, status: Optional[int], data: Optional[dict], code: str) -> None:
        self.status, self.data, self.code = status, data, code

    @property
    def ok(self) -> bool:
        return self.status == 200 and self.data is not None


def cp_call(op: str, body: dict, home: Optional[str] = None) -> Reply:
    """One POST to the control plane (blocking; called through asyncio.to_thread). Never raises."""
    origin = cp_origin(env(URL_ENV, home))
    key = env(CREDENTIAL_ENV, home)
    tenant = tenant_id(home)
    if origin is None or not key or tenant is None:
        return Reply(None, None, "not_configured")
    url = origin + (READ_PATH if op == "read" else RATE_PATH).format(tenant=tenant)
    request = urllib.request.Request(url, data=json.dumps(body, separators=(",", ":")).encode("utf-8"), method="POST",
                                     headers={"Content-Type": "application/json", "Accept": "application/json", "Authorization": f"Bearer {key}"})
    try:
        with _OPENER.open(request, timeout=HTTP_TIMEOUT_S) as response:
            status, raw = int(getattr(response, "status", 0) or 0), response.read(RESPONSE_MAX_BYTES + 1)
    except urllib.error.HTTPError as error:
        status = int(error.code)
        try:
            raw = error.read(RESPONSE_MAX_BYTES + 1)
        except Exception:  # noqa: BLE001
            raw = b""
    except (TimeoutError, OSError, http.client.HTTPException, ValueError) as error:
        return Reply(None, None, "timeout" if "timed out" in str(error).lower() or isinstance(error, TimeoutError) else "network")
    if len(raw) > RESPONSE_MAX_BYTES:
        return Reply(status, None, "bad_response")
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        data = None
    if not isinstance(data, dict):
        return Reply(status, None, "bad_response" if status == 200 else f"http_{status}")
    code = data.get("state") if status == 200 else data.get("error")
    code = code if isinstance(code, str) and re.fullmatch(r"[a-z][a-z0-9_]{0,63}", code) else ("bad_response" if status == 200 else f"http_{status}")
    return Reply(status, data, code)


# --------------------------------------------------------------------------- owner (av-vote's rule)


def _positive_id(value: Any) -> Optional[str]:
    text = str(value).strip() if isinstance(value, (int, str)) and not isinstance(value, bool) else ""
    return text if _TELEGRAM_USER.fullmatch(text) else None


def _home_field(adapter: Any, fields: tuple) -> list:
    found = []
    try:
        home = getattr(getattr(adapter, "config", None), "home_channel", None)
        for field in fields:
            value = home.get(field) if isinstance(home, dict) else getattr(home, field, None)
            ident = _positive_id(value) if value is not None else None
            if ident:
                found.append(ident)
    except Exception:  # noqa: BLE001 - an unreadable config falls back to the env
        pass
    return found


def owner_ids(adapter: Any = None) -> set:
    found = set(_home_field(adapter, ("user_id", "chat_id")))
    env_id = _positive_id(os.environ.get(HOME_CHANNEL_ENV, ""))
    if env_id:
        found.add(env_id)
    return found


def home_chat_id(adapter: Any = None) -> Optional[str]:
    """Where the cards go: the home channel's positive chat id, else its user id, else TELEGRAM_HOME_CHANNEL."""
    found = _home_field(adapter, ("chat_id", "user_id"))
    return found[0] if found else _positive_id(os.environ.get(HOME_CHANNEL_ENV, ""))


def paired_on_box(user: str) -> bool:
    try:
        from gateway.pairing import PairingStore  # noqa: PLC0415 - Hermes, in-process on a box

        return bool(PairingStore().is_approved("telegram", user))
    except Exception:  # noqa: BLE001
        return False


def is_owner_tap(adapter: Any, user: Optional[str], chat: Optional[str], chat_type: Optional[str]) -> bool:
    if user is None or (chat is not None and chat != user):
        return False
    if isinstance(chat_type, str) and chat_type and chat_type != "private":
        return False
    if user in owner_ids(adapter):
        return True
    return chat is not None and paired_on_box(user)


# --------------------------------------------------------------------------- sending


def _send_lock() -> asyncio.Lock:
    global _SEND_LOCK
    if _SEND_LOCK is None:
        _SEND_LOCK = asyncio.Lock()
    return _SEND_LOCK


async def _send(bot: Any, chat: str, text: str, markup: Any = None) -> Optional[int]:
    """One message; its id, or None when Telegram refused or failed (blocked bot, network)."""
    try:
        message = await bot.send_message(chat_id=int(chat), text=text, parse_mode="HTML", reply_markup=markup, disable_web_page_preview=True)
    except Exception:  # noqa: BLE001
        return None
    return getattr(message, "message_id", None) or 0


async def _send_page(bot: Any, chat: str, session: dict, view: dict, page: int, rated: set, home: Optional[str],
                     make_button: Callable, make_markup: Callable, count: Callable) -> bool:
    """The page's unrated cards (texts from the fresh read, never the ledger). True when every card went out."""
    n = len(session["order"])
    texts = {s["id"]: s for s in view["statements"]}
    positions = L.to_send(page, n, rated, session["cards"].keys())
    for position in positions:
        submit = position == positions[-1]
        sid = session["order"][position]
        statement = texts.get(sid)
        if statement is None:
            count("order_mismatch")
            return False
        label = view["categories"].get(statement["category"], "Other")
        message_id = await _send(bot, chat, L.card_text(position, n, label, statement["text"]),
                                 make_markup(L.rating_rows(session["nonce"], position, make_button, submit=submit)))
        if message_id is None:
            return False
        session["cards"][str(position)] = {"message_id": message_id, "submit": submit}
        _SHOWN[(session["nonce"], position)] = None
        set_page_open(True, home, touch=True)
        count("card_sent")
        await asyncio.sleep(SEND_GAP_S)
    session["page"] = max(int(session["page"]), page)
    return True


async def sync(bot: Any, adapter: Any, view: dict, make_button: Callable, make_markup: Callable,
               home: Optional[str] = None, now: Optional[float] = None) -> dict:
    """Apply a fresh read to this box's cards: start, advance, re-mark, end, or settle. Returns code -> count; never
    raises. The caller has checked the switch; texts and values in `view` are used here and never written."""
    codes: dict = {}
    stamp = time.time() if now is None else now

    def count(code: str, n: int = 1) -> None:
        codes[code] = codes.get(code, 0) + n

    try:
        async with _send_lock():
            await _sync_locked(bot, adapter, view, make_button, make_markup, home, stamp, count)
    except Exception:  # noqa: BLE001
        logger.warning("av-godconst: tenant=%s outcome=sync_error", tenant_id8())
        count("sync_error")
    if codes:
        _log("sync", **codes)
    return codes


async def _sync_locked(bot: Any, adapter: Any, view: dict, make_button: Callable, make_markup: Callable,
                       home: Optional[str], now: float, count: Callable) -> None:
    with _LEDGER_LOCK:
        ledger, why = load_ledger(home)
    if why not in (None, "missing"):
        count(f"ledger_{why}")
        return
    session = ledger.get("session")
    state = view["state"]
    pool = view.get("pool")
    same_pool = session is not None and pool is not None and session["pool_sha256"] == pool["sha256"]
    if state in ("closed", "no_pool", "not_participant") or (state == "submitted" and not same_pool):
        if session is not None and state == "closed" and end_session(ledger, "closed", home, now):
            count("ended_closed")
        return
    if state == "submitted":
        if end_session(ledger, "submitted", home, now):
            count("ended_submitted")
        return
    # state == "open"
    if not same_pool and ended_for(ledger, pool_sha256=pool["sha256"]):
        count("ended_here")  # this pool's ballot ended on this box: never restarted
        return
    chat = home_chat_id(adapter)
    if chat is None:
        count("no_home_chat")
        return
    closes = L.epoch_from_iso(pool["closes_at"]) if pool["closes_at"] else None
    if same_pool and closes is not None and now >= closes:
        end_session(ledger, "closed", home, now)
        count("ended_window")
        return
    if not same_pool:
        # A new pool (or none before): start, in village daytime, inside the window, unless all is rated already.
        if closes is not None and now >= closes:
            count("window_over")
            return
        if not L.in_first_send_window(now):
            count("waiting_daytime")
            return
        session = new_session(view, now)
        ledger.pop("ended", None)
        ledger["session"] = session
        rated = L.rated_positions(session["order"], view["ratings"])
        session["rated"] = sorted(rated)
        if len(rated) == len(session["order"]):
            session["status"] = "done"
            count("all_rated_on_web")
            _store(ledger, home, now)
            return
        header = await _send(bot, chat, L.header_text(len(session["order"]), closes),
                             make_markup(L.control_rows(session["nonce"], make_button, stopped=False)))
        if header is None:
            count("send_failed")
            return  # nothing kept: the next pass starts again
        session["header_message_id"] = header
        _store(ledger, home, now)
        count("started")
        _log("order", rule=session["order_rule"], n=len(session["order"]))
    if session["order"] != [s["id"] for s in view["statements"]]:
        # The app's order for this pool never changes; a different one is a fault, never re-sent.
        count("order_changed")
        return
    rated = L.rated_positions(session["order"], view["ratings"])
    session["rated"] = sorted(rated)
    await _remark(bot, chat, session, view, make_button, make_markup, count)
    if session["status"] != ACTIVE:
        _store(ledger, home, now)
        return
    await _advance(bot, chat, session, view, rated, closes, now, home, make_button, make_markup, count)
    _store(ledger, home, now)


def _store(ledger: dict, home: Optional[str], now: Optional[float] = None) -> None:
    with _LEDGER_LOCK:
        save_ledger(ledger, home)
    set_page_open(page_is_open(ledger.get("session"), time.time() if now is None else now), home)


async def _advance(bot: Any, chat: str, session: dict, view: dict, rated: set, closes: Optional[float], now: float, home: Optional[str],
                   make_button: Callable, make_markup: Callable, count: Callable) -> None:
    n = len(session["order"])
    page = int(session["page"])
    # The current page first: a card of it that never went out (a failed send) goes now.
    if page >= 0 and L.to_send(page, n, rated, session["cards"].keys()):
        if not await _send_page(bot, chat, session, view, page, rated, home, make_button, make_markup, count):
            _send_failed(session, count)
            return
    if not L.page_done(page, n, rated):
        return
    nxt = L.next_page(page, n, rated)
    if nxt is None:
        if not session["final_sent"]:
            text = L.done_text(n) if len(rated) == n else L.end_text(len(rated), n)
            if await _send(bot, chat, text, make_markup(L.submit_rows(session["nonce"], make_button))) is None:
                _send_failed(session, count)
                return
            session["final_sent"] = True
            session["status"] = "done"
            count("final_sent")
        return
    if closes is not None and now >= closes:
        count("window_over")
        return
    if await _send_page(bot, chat, session, view, nxt, rated, home, make_button, make_markup, count):
        session["send_failures"] = 0
        count("page_sent")
    else:
        _send_failed(session, count)


def _send_failed(session: dict, count: Callable) -> None:
    session["send_failures"] = int(session.get("send_failures", 0)) + 1
    count("send_failed")
    if session["send_failures"] >= SEND_FAILURES_MAX:
        session["status"] = "undeliverable"
        count("settled_undeliverable")


async def _remark(bot: Any, chat: str, session: dict, view: dict, make_button: Callable, make_markup: Callable, count: Callable) -> None:
    """A sent card whose check differs from the ballot (a change on the web page, or unknown after a restart) gets its
    keyboard redrawn from the app's value. What a card shows is remembered in memory only (``_SHOWN``)."""
    edits = 0
    for position, card in list(session["cards"].items()):
        if edits >= REMARKS_PER_PASS:
            break
        sid = session["order"][int(position)]
        value = view["ratings"].get(sid)
        key = (session["nonce"], int(position))
        if key in _SHOWN and _SHOWN[key] == value:
            continue
        try:
            await bot.edit_message_reply_markup(chat_id=int(chat), message_id=int(card["message_id"]),
                                                reply_markup=make_markup(L.rating_rows(session["nonce"], int(position), make_button, value, submit=bool(card.get("submit")))))
        except Exception:  # noqa: BLE001 - "message is not modified", a deleted card: remembered anyway
            count("remark_failed")
        _SHOWN[key] = value
        edits += 1
        count("remarked")


# --------------------------------------------------------------------------- the pass


async def pass_once(bot: Any, adapter: Any, make_button: Callable, make_markup: Callable, home: Optional[str] = None,
                    now: Optional[float] = None, reader: Optional[Callable] = None) -> str:
    """One pass: read when due, then sync. Returns a code; never raises."""
    stamp = time.time() if now is None else now
    try:
        if not ballot_on(home):
            return "off"
        with _LEDGER_LOCK:
            ledger, why = load_ledger(home)
        if why not in (None, "missing"):
            _log(f"ledger_{why}")
            return f"ledger_{why}"
        session = ledger.get("session")
        closes = L.epoch_from_iso(session.get("closes_at")) if session is not None and session.get("closes_at") else None
        if closes is not None and stamp >= closes:
            end_session(ledger, "closed", home, stamp)  # the pool's rating window is over: nothing of it stays here
            return "window_over"
        live = session is not None and session["status"] in (ACTIVE, STOPPED)
        if stamp - _last_read["at"] < (POLL_ACTIVE_S if live else POLL_IDLE_S):
            return "not_due"
        _last_read["at"] = stamp
        reply = await asyncio.to_thread(reader or cp_call, "read", {}, home)
        if not reply.ok:
            if session is not None and REFUSAL_STATUS.get(reply.code) == "withdrawn":
                end_session(ledger, "withdrawn", home, stamp)
            _log("read_failed", code=reply.code)
            return reply.code
        view = L.valid_view(reply.data)
        if view is None:
            _log("read_bad_shape")
            return "bad_shape"
        await sync(bot, adapter, view, make_button, make_markup, home, stamp)
        return view["state"]
    except Exception:  # noqa: BLE001 - the pass never raises into the gateway
        logger.warning("av-godconst: tenant=%s outcome=pass_error", tenant_id8())
        return "pass_error"


# --------------------------------------------------------------------------- the tap


def _button_fields(button: Any) -> tuple:
    if isinstance(button, dict):
        return str(button.get("text", "")), button.get("callback_data")
    return str(getattr(button, "text", "") or ""), getattr(button, "callback_data", None)


def mark_keyboard(rows: Any, data: str, make_button: Callable) -> Optional[list]:
    """The card's keyboard with the check on the tapped ``gcb:`` button only; None when nothing changes."""
    if not rows:
        return None
    found = changed = False
    out = []
    for row in rows:
        new_row = []
        for button in row or ():
            text, callback = _button_fields(button)
            if isinstance(callback, str) and callback.startswith(L.PREFIX):
                bare = text[len(L.CHECK):] if text.startswith(L.CHECK) else text
                want = L.CHECK + bare if callback == data else bare
                found = found or callback == data
                if want != text:
                    changed = True
                    new_row.append(make_button(want, callback))
                    continue
            new_row.append(button)
        out.append(new_row)
    return out if found and changed else None


async def _answer(query: Any, text: str) -> None:
    try:
        await query.answer(text=text if len(text) <= ANSWER_MAX else text[: ANSWER_MAX - 3] + "...")
    except Exception:  # noqa: BLE001 - an expired query cannot be answered
        logger.debug("av-godconst: answerCallbackQuery failed")  # no exc_info: an exception can echo the callback data


def make_handler(adapter: Any = None, *, make_button: Callable, make_markup: Callable, home: Optional[str] = None,
                 clock: Callable[[], float] = time.time, caller: Optional[Callable] = None) -> Callable:
    """The PTB callback for ``gcb:`` taps."""
    call = caller or cp_call

    async def on_tap(update: Any, context: Any = None) -> None:
        query = getattr(update, "callback_query", None)
        if query is None:
            return
        key: Optional[tuple] = None
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
            parsed = L.parse_callback(data)
            if parsed is None:
                _log("bad_data")
                await _answer(query, BAD_BUTTON)
                return
            key = (str(chat), str(getattr(message, "message_id", "")))
            if key in _in_flight:
                key = None
                _log("in_flight")
                await _answer(query, IN_FLIGHT)
                return
            _in_flight.add(key)
            with _LEDGER_LOCK:
                ledger, why = load_ledger(home)
            session = ledger.get("session") if why is None else None
            ended = ended_for(ledger, nonce=parsed[1]) if why is None else None
            if ended is not None:
                _log("ended_card", status=ended)
                await _answer(query, ENDED_TEXT[ended])
                return
            if session is None or session.get("nonce") != parsed[1]:
                _log("old_card" if why is None else f"ledger_{why}")
                await _answer(query, OLD_CARD)
                return
            closes = L.epoch_from_iso(session.get("closes_at")) if session.get("closes_at") else None
            if closes is not None and clock() >= closes:
                end_session(ledger, "closed", home, clock())
                await _answer(query, CLOSED)
                return
            if parsed[0] in ("stop", "resume"):
                await _control(query, message, parsed[0], session, ledger, make_button, make_markup, home)
                return
            if parsed[0] in ("submit", "confirm", "cancel"):
                await _submit(query, message, parsed[0], session, ledger, call, make_button, make_markup, home, clock)
                return
            _, _, position, value = parsed
            if position >= len(session["order"]):
                _log("bad_position")
                await _answer(query, BAD_BUTTON)
                return
            sid = session["order"][position]
            reply = await asyncio.to_thread(call, "rate", {"pool_sha256": session["pool_sha256"], "statement_id": sid, "rating": value}, home)
            if not reply.ok or reply.code != "saved":
                await _refused(query, reply, session, ledger, home)
                return
            ratings = reply.data.get("ratings") if isinstance(reply.data.get("ratings"), dict) else {}
            changed = position in set(session.get("rated", []))
            _log("saved", revision=reply.data.get("revision", 0) if isinstance(reply.data.get("revision"), int) else 0)
            await _answer(query, f"Saved: {L.LABELS[value]}" + (" (changed)" if changed else ""))
            rows = getattr(getattr(message, "reply_markup", None), "inline_keyboard", None)
            marked = mark_keyboard(rows, data, make_button)
            if marked is not None:
                try:
                    await query.edit_message_reply_markup(reply_markup=make_markup(marked))
                except Exception:  # noqa: BLE001 - saved already; a stale check is cosmetic
                    _log("edit_failed")
            with _LEDGER_LOCK:
                ledger, why = load_ledger(home)
                fresh = ledger.get("session") if why is None else None
                if fresh is not None and fresh.get("nonce") == session["nonce"]:
                    if str(position) in fresh["cards"]:
                        _SHOWN[(fresh["nonce"], position)] = value
                    fresh["rated"] = sorted(L.rated_positions(fresh["order"], ratings))
                    save_ledger(ledger, home)
                    session = fresh
            set_page_open(page_is_open(session, clock()), home)
            rated = set(session["rated"])
            n = len(session["order"])
            if session["status"] == ACTIVE and L.page_done(int(session["page"]), n, rated):
                # The pair is rated: read (for the next texts) and advance.
                follow = await asyncio.to_thread(call, "read", {}, home)
                view = L.valid_view(follow.data) if follow.ok else None
                if view is not None:
                    bot = _bot_of(query, message)
                    if bot is not None:
                        await sync(bot, adapter, view, make_button, make_markup, home, clock())
                else:
                    _log("advance_read_failed", code=follow.code)
        except Exception:  # noqa: BLE001 - fail-open: never raise into the gateway
            logger.warning("av-godconst: tenant=%s outcome=handler_error", tenant_id8())
            await _answer(query, FAILED)
        finally:
            if key is not None:
                _in_flight.discard(key)

    return on_tap


def _bot_of(query: Any, message: Any) -> Any:
    getter = getattr(message, "get_bot", None)
    if callable(getter):
        try:
            return getter()
        except Exception:  # noqa: BLE001
            pass
    return getattr(query, "bot", None) or getattr(message, "bot", None)


async def _refused(query: Any, reply: Reply, session: dict, ledger: dict, home: Optional[str]) -> None:
    """A refused save or submit: the answer, and for a final refusal (submitted, closed, withdrawn, no longer admitted)
    the session deleted (a tombstone stays)."""
    _log("save_refused", code=reply.code)
    status = REFUSAL_STATUS.get(reply.code)
    if status is not None:
        with _LEDGER_LOCK:
            fresh, why = load_ledger(home)
        s = fresh.get("session") if why is None else None
        if s is not None and s.get("nonce") == session["nonce"]:
            end_session(fresh, status, home)
    await _answer(query, REFUSAL_TEXT.get(reply.code, FAILED))


async def _submit(query: Any, message: Any, kind: str, session: dict, ledger: dict, call: Callable, make_button: Callable,
                  make_markup: Callable, home: Optional[str], clock: Callable[[], float]) -> None:
    """Submit asks to confirm (a message with Yes / Not yet); Yes submits the app's latest merged draft (partial
    allowed, final); then the session is deleted and every later tap answers that the ballot is submitted."""
    bot = _bot_of(query, message)
    chat = getattr(getattr(message, "chat", None), "id", None)
    if kind == "submit":
        # The count shown is the app's, read now (a rating given on the web page since the last tap counts too).
        read = await asyncio.to_thread(call, "read", {}, home)
        view = L.valid_view(read.data) if read.ok else None
        if view is None:
            if read.code in REFUSAL_STATUS:
                await _refused(query, read, session, ledger, home)
            else:
                await _answer(query, FAILED)
            return
        if view["state"] != "open":
            await _answer(query, SUBMITTED if view["state"] == "submitted" else CLOSED)
            return
        n = len(view["statements"])
        rated = sum(1 for st in view["statements"] if st["id"] in view["ratings"])
        await _answer(query, "Confirm below.")
        if bot is not None and chat is not None:
            await _send(bot, str(chat), L.confirm_text(rated, n), make_markup(L.confirm_rows(session["nonce"], make_button)))
        _log("submit_asked", n_rated=rated)
        return
    if kind == "cancel":
        await _answer(query, "Not submitted. You can keep rating.")
        try:
            await query.edit_message_reply_markup(reply_markup=None)
        except Exception:  # noqa: BLE001
            _log("edit_failed")
        return
    reply = await asyncio.to_thread(call, "submit", {"pool_sha256": session["pool_sha256"]}, home)
    if not reply.ok or reply.code != "submitted":
        if reply.code == "incomplete":
            await _answer(query, "Rate at least one statement before you submit.")
            return
        await _refused(query, reply, session, ledger, home)
        return
    with _LEDGER_LOCK:
        fresh, why = load_ledger(home)
    if why is None and isinstance(fresh.get("session"), dict) and fresh["session"].get("nonce") == session["nonce"]:
        end_session(fresh, "submitted", home, clock())
    _log("submitted")
    await _answer(query, "Submitted")
    try:
        await query.edit_message_reply_markup(reply_markup=None)
    except Exception:  # noqa: BLE001
        _log("edit_failed")
    n_rated = reply.data.get("n_rated") if isinstance(reply.data.get("n_rated"), int) else None
    if bot is not None and chat is not None:
        await _send(bot, str(chat), L.submitted_text(n_rated, len(session["order"])))


async def _control(query: Any, message: Any, kind: str, session: dict, ledger: dict, make_button: Callable, make_markup: Callable,
                   home: Optional[str]) -> None:
    """Stop: no more cards (taps still save). Resume: cards again from the next pass (or the next tap)."""
    if session["status"] in FINAL:
        await _answer(query, "This ballot's cards are finished.")
        return
    stopped = kind == "stop"
    with _LEDGER_LOCK:
        fresh, why = load_ledger(home)
        s = fresh.get("session") if why is None else None
        if s is None or s.get("nonce") != session["nonce"]:
            await _answer(query, OLD_CARD)
            return
        s["status"] = STOPPED if stopped else ACTIVE
        save_ledger(fresh, home)
    set_page_open(page_is_open(s, time.time()), home)
    _last_read["at"] = 0.0  # resume: the next pass reads at once
    _log("stopped" if stopped else "resumed")
    await _answer(query, "Stopped. Your ratings are kept." if stopped else "Resumed. The next statements come shortly.")
    try:
        await query.edit_message_reply_markup(reply_markup=make_markup(L.control_rows(session["nonce"], make_button, stopped=stopped)))
    except Exception:  # noqa: BLE001
        _log("edit_failed")
    if stopped:
        bot = _bot_of(query, message)
        chat = getattr(getattr(message, "chat", None), "id", None)
        if bot is not None and chat is not None:
            await _send(bot, str(chat), L.stopped_text())


# --------------------------------------------------------------------------- wiring


def _wire_telegram(application: Any, adapter: Any) -> None:
    """Factory Hermes calls at Telegram connect with the PTB ``Application``; SDK imports stay here."""
    from telegram import InlineKeyboardButton, InlineKeyboardMarkup  # noqa: PLC0415
    from telegram.ext import CallbackQueryHandler  # noqa: PLC0415

    make_button = lambda text, data: InlineKeyboardButton(text=text, callback_data=data)  # noqa: E731
    make_markup = lambda rows: InlineKeyboardMarkup(rows)  # noqa: E731
    application.add_handler(CallbackQueryHandler(make_handler(adapter, make_button=make_button, make_markup=make_markup),
                                                 pattern=L.HANDLER_PATTERN, block=False))
    logger.info("av-godconst: ballot card buttons wired (pattern %s)", L.HANDLER_PATTERN)

    async def tick(*_: Any) -> None:
        await pass_once(application.bot, adapter, make_button, make_markup)

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        job_queue = getattr(application, "job_queue", None)
    if job_queue is not None and callable(getattr(job_queue, "run_repeating", None)):
        try:
            job_queue.run_repeating(tick, interval=PASS_INTERVAL_S, first=10.0, name="av-godconst-pass")
            logger.info("av-godconst: pass on the job queue every %ss", int(PASS_INTERVAL_S))
            return
        except Exception:  # noqa: BLE001
            logger.info("av-godconst: job queue refused; using a loop task")

    async def loop() -> None:
        await asyncio.sleep(10.0)
        while True:
            await tick()
            await asyncio.sleep(PASS_INTERVAL_S)

    try:
        asyncio.get_running_loop().create_task(loop(), name="av-godconst-pass")
        logger.info("av-godconst: pass on a loop task every %ss", int(PASS_INTERVAL_S))
    except RuntimeError:
        logger.warning("av-godconst: no running loop at wire time; cards advance on taps only")


def register(ctx: Any) -> None:
    """Hermes plugin entrypoint: one scoped Telegram callback handler and the pass. No tools, no hooks. At start the
    page-open marker is reconciled with the ledger (removed unless a page is open inside the window)."""
    try:
        reconcile_page_open()
    except Exception:  # noqa: BLE001
        logger.warning("av-godconst: page marker reconcile failed")
    try:
        wire = getattr(ctx, "register_platform_handler", None)
        if callable(wire):
            wire("telegram", _wire_telegram)
            return
        legacy = getattr(ctx, "register_telegram_handler", None)
        if callable(legacy):
            legacy(_wire_telegram)
            return
        logger.warning("av-godconst: this Hermes has no platform handler registration; cards are off")
    except Exception:  # noqa: BLE001
        logger.warning("av-godconst: could not register the ballot card handler", exc_info=True)


__all__ = [
    "Reply", "ballot_on", "cp_call", "cp_origin", "home_chat_id", "is_owner_tap", "ledger_path", "load_ledger",
    "make_handler", "mark_keyboard", "new_session", "pass_once", "register", "save_ledger", "sync",
]
