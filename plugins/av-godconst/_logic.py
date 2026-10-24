"""av-godconst pure logic: pages, texts, callback data, the read's shape. Standard library only, no I/O.

Nothing here keeps a statement's text or a rating value: texts and values pass through these functions on their way
to Telegram and are never returned into the ledger. The ledger holds positions, message ids and keyed marks.
"""

from __future__ import annotations

import html
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Optional

#: Telegram callback_data prefix; the PTB handler is scoped to it.
PREFIX = "gcb:"
HANDLER_PATTERN = r"^gcb:"
CALLBACK_DATA_MAX_BYTES = 64
NONCE_CHARS = 8
#: gcb:r:<nonce>:<position>:<value> a rating; gcb:x / gcb:g stop / resume; gcb:s Submit (asks to confirm); gcb:y / gcb:n
#: the confirmation's yes / not yet. All with the session nonce.
_CALLBACK = re.compile(r"^gcb:(?:r:([A-Za-z0-9_-]{8}):(0|[1-9][0-9]{0,2}):([1-5])|([xgsyn]):([A-Za-z0-9_-]{8}))$")
_KINDS = {"x": "stop", "g": "resume", "s": "submit", "y": "confirm", "n": "cancel"}

#: The delivery rule's one knob (lead: pairs). A page is this many statements of the resident's order; with the app's
#: godconst-order-v2, positions (2k, 2k+1) are one agent-written and one ODIN-written statement.
PAIRS_PER_PAGE = 1
PAGE_SIZE = 2 * PAIRS_PER_PAGE

#: contracts.ts RATING_LABELS, exactly.
LABELS = {1: "Strongly oppose inclusion", 2: "Oppose inclusion", 3: "Neutral", 4: "Support inclusion", 5: "Strongly support inclusion"}
CHECK = "✅ "
IST = timezone(timedelta(hours=5, minutes=30))
#: Village daytime (B7's opener window): a ballot's first card and every send a pass (a tick) makes go out only inside
#: it; the reply to the resident's own tap goes at once (ov#483 N2).
SEND_FROM = (8, 0)
SEND_UNTIL = (21, 30)

STATES = ("open", "submitted", "closed", "no_pool", "not_participant")
_SHA = re.compile(r"^[0-9a-f]{64}$")
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_STATEMENT_ID = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
_CATEGORY = re.compile(r"^[a-z0-9_-]{1,64}$")
_ORDER_RULE = re.compile(r"^[A-Za-z0-9._-]{1,40}$")
TEXT_MAX = 2000
LABEL_MAX = 120
MAX_STATEMENTS = 500


# --------------------------------------------------------------------------- callback data


def rating_callback(nonce: str, position: int, value: int) -> str:
    return f"gcb:r:{nonce}:{position}:{value}"


def control_callback(kind: str, nonce: str) -> str:
    return f"gcb:{kind}:{nonce}"


def parse_callback(data: Any) -> Optional[tuple]:
    """``("rate", nonce, position, value)``, or ``(<stop|resume|submit|confirm|cancel>, nonce)``; None for anything else."""
    if not isinstance(data, str) or len(data.encode("utf-8")) > CALLBACK_DATA_MAX_BYTES:
        return None
    m = _CALLBACK.fullmatch(data)
    if m is None:
        return None
    if m.group(1) is not None:
        return ("rate", m.group(1), int(m.group(2)), int(m.group(3)))
    return (_KINDS[m.group(4)], m.group(5))


SUBMIT_LABEL = "Submit my ratings"


def rating_rows(nonce: str, position: int, make_button: Any, selected: Optional[int] = None, submit: bool = False) -> list:
    """Five buttons; `submit` adds a second row (the last card of each page: Submit is never more than a scroll away)."""
    rows = [[make_button((CHECK if selected == v else "") + str(v), rating_callback(nonce, position, v)) for v in range(1, 6)]]
    if submit:
        rows.append([make_button(SUBMIT_LABEL, control_callback("s", nonce))])
    return rows


def control_rows(nonce: str, make_button: Any, stopped: bool) -> list:
    return [[make_button(SUBMIT_LABEL, control_callback("s", nonce)),
             make_button("Resume these cards" if stopped else "Stop these cards", control_callback("g" if stopped else "x", nonce))]]


def submit_rows(nonce: str, make_button: Any) -> list:
    return [[make_button(SUBMIT_LABEL, control_callback("s", nonce))]]


def confirm_rows(nonce: str, make_button: Any) -> list:
    return [[make_button("Yes, submit", control_callback("y", nonce)), make_button("Not yet", control_callback("n", nonce))]]


# --------------------------------------------------------------------------- the read's shape


def valid_view(data: Any) -> Optional[dict]:
    """The app's read (telegram-ballot.ts TelegramBallotView), checked, or None. Unknown keys are dropped."""
    if not isinstance(data, dict) or data.get("state") not in STATES:
        return None
    state = data["state"]
    out: dict = {"state": state, "pool": None, "categories": {}, "statements": [], "ratings": {}}
    ratings = data.get("ratings", {})
    if not isinstance(ratings, dict) or len(ratings) > MAX_STATEMENTS:
        return None
    for sid, value in ratings.items():
        if not (isinstance(sid, str) and _STATEMENT_ID.fullmatch(sid) and type(value) is int and 1 <= value <= 5):
            return None
    out["ratings"] = dict(ratings)
    if state not in ("open", "submitted"):
        return out
    pool = data.get("pool")
    if not isinstance(pool, dict):
        return None
    pid, sha, closes, rule = pool.get("id"), pool.get("sha256"), pool.get("rating_closes_at"), pool.get("order_rule")
    if not (isinstance(pid, str) and _UUID.fullmatch(pid) and isinstance(sha, str) and _SHA.fullmatch(sha)):
        return None
    if closes is not None and epoch_from_iso(closes) is None:
        return None
    out["pool"] = {"id": pid, "sha256": sha, "closes_at": closes, "order_rule": rule if isinstance(rule, str) and _ORDER_RULE.fullmatch(rule) else "unknown"}
    categories = data.get("categories", [])
    if not isinstance(categories, list):
        return None
    for c in categories:
        if isinstance(c, dict) and isinstance(c.get("id"), str) and _CATEGORY.fullmatch(c["id"]) and isinstance(c.get("label"), str):
            out["categories"][c["id"]] = c["label"][:LABEL_MAX]
    statements = data.get("statements", [])
    if not isinstance(statements, list) or len(statements) > MAX_STATEMENTS:
        return None
    seen = set()
    for s in statements:
        if not isinstance(s, dict):
            return None
        sid, cat, text = s.get("id"), s.get("category"), s.get("text")
        if not (isinstance(sid, str) and _STATEMENT_ID.fullmatch(sid) and sid not in seen and isinstance(cat, str) and isinstance(text, str)
                and 0 < len(text) <= TEXT_MAX):
            return None
        seen.add(sid)
        out["statements"].append({"id": sid, "category": cat, "text": text})
    if state == "open" and not out["statements"]:
        return None
    return out


# --------------------------------------------------------------------------- pages


def page_count(n: int) -> int:
    return (n + PAGE_SIZE - 1) // PAGE_SIZE


def page_positions(page: int, n: int) -> list:
    return [p for p in range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) if p < n]


def rated_positions(order: list, ratings: dict) -> set:
    return {i for i, sid in enumerate(order) if sid in ratings}


def page_done(page: int, n: int, rated: set) -> bool:
    """The page (the latest one sent) is fully rated; no page sent yet counts as done."""
    return page < 0 or all(p in rated for p in page_positions(page, n))


def next_page(current: int, n: int, rated: set) -> Optional[int]:
    """The next page after `current` holding an unrated statement (one rated on the web page is skipped), or None."""
    for page in range(current + 1, page_count(n)):
        if any(p not in rated for p in page_positions(page, n)):
            return page
    return None


def to_send(page: int, n: int, rated: set, sent: Iterable) -> list:
    """The positions of `page` that still need a card: not rated (on the web) and not already sent."""
    have = {int(p) for p in sent}
    return [p for p in page_positions(page, n) if p not in rated and p not in have]


# --------------------------------------------------------------------------- times


def epoch_from_iso(value: Any) -> Optional[float]:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        stamp = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return None if stamp.tzinfo is None else stamp.timestamp()


def in_send_window(now: float) -> bool:
    local = datetime.fromtimestamp(now, tz=IST)
    minutes = local.hour * 60 + local.minute
    return SEND_FROM[0] * 60 + SEND_FROM[1] <= minutes < SEND_UNTIL[0] * 60 + SEND_UNTIL[1]


def ist_label(epoch: float) -> str:
    local = datetime.fromtimestamp(epoch, tz=IST)
    return f"{local.strftime('%H:%M')} IST, {local.strftime('%a')} {local.day} {local.strftime('%b')}"


# --------------------------------------------------------------------------- texts (HTML, escaped)


def _esc(lines: list) -> str:
    return "\n".join(html.escape(line, quote=False) for line in lines)


def header_text(n: int, closes_at: Optional[float]) -> str:
    lines = [
        f"Village constitution: {n} statements to rate",
        "",
        "Tap one button per statement, from 1 to 5. Rate as many as you can: an unrated statement counts as no opinion. "
        "Tap again to change a rating. You won't see who wrote each statement.",
        "",
    ]
    lines += [f"{v}  {label}" for v, label in LABELS.items()]
    lines += [
        "",
        f"You'll get {PAGE_SIZE} statements at a time; the next ones arrive once you've rated these. "
        "Each tap is saved on your ballot straight away, the same ballot as on the Constitution page. "
        "When you're done, press Submit my ratings: you can submit with some statements unrated.",
    ]
    if closes_at is not None:
        lines += ["", f"Open until {ist_label(closes_at)}."]
    lines += ["", "Private: only you and the research team see your ratings. Your agent does not see these cards."]
    return _esc(lines)


def card_text(position: int, n: int, category_label: str, text: str) -> str:
    return _esc([f"Statement {position + 1} of {n} · {category_label}", "", text, "",
                 "1 strongly oppose inclusion · 3 neutral · 5 strongly support inclusion"])


def done_text(n: int) -> str:
    return _esc([f"All {n} statements rated. Thank you.",
                 "Press Submit my ratings to make them final, or change any rating first by tapping again."])


def end_text(rated: int, n: int) -> str:
    return _esc([f"That's every statement. You rated {rated} of {n}; the others count as no opinion.",
                 "You can still tap any card above, then press Submit my ratings to make them final."])


def confirm_text(rated: int, n: int) -> str:
    return _esc([f"Submit your ratings now? You rated {rated} of {n}; unrated statements count as no opinion.",
                 "Once submitted, your ratings are final and can no longer change, here or on the Constitution page."])


def submitted_text(n_rated: Optional[int] = None, n: Optional[int] = None) -> str:
    """`n_rated` is the app's count from the submit's answer (never the box's own tally)."""
    if isinstance(n_rated, int) and isinstance(n, int):
        return _esc([f"Submitted: {n_rated} of {n} rated. Thank you: your ratings are final."])
    return _esc(["Submitted. Thank you: your ratings are final."])


def stopped_text() -> str:
    return _esc(["Stopped: no more statement cards. Your ratings are kept, and you can still rate on the Constitution page."])
