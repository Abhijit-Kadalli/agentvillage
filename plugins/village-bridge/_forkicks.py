"""Persist server previews, not model-supplied purchase proofs. The app/CP are authority."""
from __future__ import annotations
import hashlib
import json
import os
import re
import stat
import unicodedata
from pathlib import Path
from ._mini_apps import approval_modules, ORDER_APPROVE_IN_BOT

MAX_PAYLOAD_BYTES = 60000
SUMMARY_MAX_BYTES = 4096
# Telegram technical cards reserve the rest of a 3600-character segment for labels.
SUMMARY_HTML_MAX_BYTES = 3000

# The For Kicks flat order card (Carter P0, 21 Oct; product L17668 (a), nonav L17696/L17701, approval L17700/L17702).
# The APP builds the approval payload at prepare and hashes it (agentvillage-app forkicks.ts); the box never builds
# it. Two shapes are accepted, so the box can ship before the app switches (nonav's ordering trap L17692):
#   LEGACY_KEYS: {appId, operation, preview} (today's shape);
#   CARD_KEYS:   exactly {order, total, pickup, name} (+ `note` exactly when the order has a non-empty note), the
#                strings the minimal card quotes. The app returns the
#                order's `preview` BESIDE the payload in its prepare answer; the box saves it in the per-draftId record
#                and re-derives the four strings from it (card_fields), refusing any difference.
# Both shapes are proposed under the same class and per-draftId key as before (approval L17713: no class change in the
# v2.1.10 hotfix). Spec + golden vectors: tests/vectors/forkicks-approval-card.{md,json}.
APPROVAL_CLASS = "marketplace.app.action"
LEGACY_KEYS = frozenset({"appId", "operation", "preview"})
CARD_KEYS = frozenset({"order", "total", "pickup", "name"})
CARD_NOTE_KEY = "note"  # the optional fifth quoted key: present exactly when the order carries a non-empty note (approval L17754)
PREVIEW_KEYS = frozenset({"appId", "draftId", "quote", "displayName", "items", "fulfilment", "paymentMethod"})
# approval-md 0.4.7 telegram-minimal: a quoted value is cut past MINIMAL_QUOTE_MAX (280) code points, two of which are
# the runtime's own isolate marks, and some characters are drawn as «U+XXXX» marks (which count). A card value must be
# shown whole and unmarked, so a value longer than this, or failing card_value_fits, is not a minimal card: the app
# sends the legacy shape instead (the technical card, every line, never cut).
CARD_VALUE_MAX = 278
CARD_VALUE_REFUSED = frozenset("\u00ab\u23ce\u115f\u1160\u3164\uffa0\u2800")  # « ⏎, Hangul fillers, braille blank
# Combining marks core draws as themselves (at most CARD_MARKS_MAX in a row), minus the default-ignorable ones it marks.
CARD_MARKS_MAX = 2
CARD_MARKS_REFUSED = frozenset([0x034F, 0x17B4, 0x17B5, *range(0x180B, 0x1810), *range(0xFE00, 0xFE10), *range(0xE0100, 0xE01F0)])
MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
# Product owns these words (product-confirm, L17668): how the payment method reads after the total.
PAYMENT_WORDS = {"upi": "pay by UPI", "card_on_pickup": "card at pickup"}

def approval_summary(payload):
    """Mirrored by CP forkicksSummary; never shorten the order the human approves."""
    def text(value, allow_empty=False):
        if not isinstance(value, str) or (not allow_empty and not value.strip()) or any(unicodedata.category(c) in {"Cc", "Cf", "Cs", "Zl", "Zp"} for c in value):
            raise ValueError("approval_card_invalid")
        return json.dumps(value, ensure_ascii=False)

    def money(value):
        if type(value) is not int or not 0 <= value <= 1000000000:
            raise ValueError("approval_card_invalid")
        return str(value)

    try:
        p = payload["preview"]
        quote, fulfilment = p["quote"], p["fulfilment"]
        lines, items = quote["lines"], p["items"]
        if not isinstance(lines, list) or not lines or len(lines) != len(items):
            raise ValueError("approval_card_invalid")
        card = ["For Kicks order"]
        for line, item in zip(lines, items):
            qty = line["qty"]
            if type(qty) is not int or not 1 <= qty <= 1000000000 or qty != item["qty"] or not isinstance(line["options"], list):
                raise ValueError("approval_card_invalid")
            options = ", ".join(text(option) for option in line["options"]) or "none"
            card.append(f'{qty} × {text(line["name"])}; options: {options}; unit ₹{money(line["unitInr"])}; line ₹{money(line["lineInr"])}')
        card.append("Total: ₹" + money(quote["totalInr"]))
        kind = fulfilment["type"]
        if kind not in ("pickup", "delivery"):
            raise ValueError("approval_card_invalid")
        location = quote["location"]
        card.append("Fulfilment: " + kind)
        card.append(f'Location: {text(location["name"])} ({text(fulfilment["locationId"])}); address: {text(location["address"])}')
        date = fulfilment.get("date") or location["opens"][:10]
        if not isinstance(date, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date, flags=re.ASCII):
            raise ValueError("approval_card_invalid")
        card.append("Date (IST): " + date)
        if kind == "delivery":
            card.append("Delivery address: " + text(fulfilment["deliveryAddress"]))
        method = p["paymentMethod"]
        if method not in ("upi", "card_on_pickup"):
            raise ValueError("approval_card_invalid")
        card.append("Payment: " + ("UPI" if method == "upi" else "Card at pickup (honor system)") + "; if simulated: Test payment, no money moved")
        card.append("Café display name: " + text(p["displayName"]))
        if "note" in p:
            card.append("Note: " + text(p["note"], allow_empty=True))
        summary = "\n".join(card)
        escaped = summary.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        if len(summary.encode("utf-8")) > SUMMARY_MAX_BYTES or len(escaped.encode("utf-8")) > SUMMARY_HTML_MAX_BYTES:
            raise ValueError("approval_card_too_long")
        return summary
    except (KeyError, TypeError, IndexError, AttributeError) as error:
        raise ValueError("approval_card_invalid") from error

def canonical(payload):
    return json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)

def card_value_fits(value):
    """Whether core 0.4.7's minimal card draws `value` whole and unmarked (see CARD_VALUE_MAX): only U+0020 spaces,
    letters, numbers, punctuation and symbols (minus CARD_VALUE_REFUSED), and combining marks (minus the
    default-ignorable ones) at most CARD_MARKS_MAX in a row."""
    if not isinstance(value, str) or not 0 < len(value) <= CARD_VALUE_MAX:
        return False
    run = 0
    for c in value:
        kind = unicodedata.category(c)[0]
        if kind == "M" and ord(c) not in CARD_MARKS_REFUSED:
            run += 1
            if run > CARD_MARKS_MAX:
                return False
            continue
        run = 0
        if c != " " and (kind not in "LNPS" or c in CARD_VALUE_REFUSED):
            return False
    return True

# What the flat card shows is what the order sends (security review, WYSIWYS). Every preview field is SHOWN on the four
# rows, BOUND to a shown one, or the flat card is refused (approval_card_invalid) and the app sends the legacy shape,
# whose technical card shows everything:
#   appId                 constant "forkicks" (checked);
#   draftId               the per-draftId approval key and record (bound);
#   displayName           shown (name);
#   paymentMethod         shown (total);
#   quote.lines           name, qty, options shown (order); unitInr/lineInr are the merchant's prices summed in the shown
#                         total; itemId/optionIds must equal items[i] (bound);
#   quote.totalInr        shown (total); quote.location.name shown (pickup); the rest of the quote is the merchant's own
#                         answer for this quoteId, not text the agent sends;
#   items[i]              exactly {itemId, optionIds, qty}, equal to quote.lines[i] (bound);
#   fulfilment            exactly type (shown), locationId (equal to the quote's location id when it names one), date
#                         (shown), deliveryAddress (shown; only for delivery);
#   note                  text the agent writes to the café: shown verbatim as the fifth row (CARD_NOTE_KEY) exactly
#                         when non-empty; a flat payload without it for a draft with a note is a mismatch (refused).
FULFILMENT_KEYS = frozenset({"type", "locationId", "date", "deliveryAddress"})
# The formatter's own separators (context L17764): a merchant or agent text holding one, or starting like the delivery
# form, could draw a phantom line ("Latte; 5 × Cake"), so such an order never gets the flat card (fail closed, no
# escaping): approval_card_not_minimal, and the app sends the legacy shape. The name and note rows are exempt (each is
# its own row, verbatim).
CARD_SEPARATORS = frozenset(";×(),·")
CARD_DELIVERY_PREFIX = "Delivery to"

def _card_ambiguous(text):
    return any(c in CARD_SEPARATORS for c in text) or text.startswith(CARD_DELIVERY_PREFIX)

def _card_unshown(preview):
    """Why the flat card would not show everything this order sends, or None."""
    quote, fulfilment = preview["quote"], preview["fulfilment"]
    if not isinstance(fulfilment, dict) or not set(fulfilment) <= FULFILMENT_KEYS or (fulfilment["type"] != "delivery" and "deliveryAddress" in fulfilment):
        return "fulfilment"
    location = quote["location"]
    if fulfilment.get("locationId") != location.get("id", fulfilment.get("locationId")) or fulfilment.get("locationId") != quote.get("locationId", fulfilment.get("locationId")):
        return "location"
    for item, line in zip(preview["items"], quote["lines"]):
        if not isinstance(item, dict) or set(item) != {"itemId", "optionIds", "qty"} or line.get("itemId") != item["itemId"] or line.get("optionIds") != item["optionIds"]:
            return "items"
    return None

def card_fields(preview):
    """The four strings of the flat order card, from the app's saved order preview. Mirrored byte for byte by the app
    (prepare + confirm) and the CP forkicksSummary mirror; spec + golden vectors in tests/vectors/."""
    approval_summary({"preview": preview})  # every check the technical card makes, first
    try:
        if _card_unshown(preview) is not None:
            raise ValueError("approval_card_invalid")
        quote, fulfilment = preview["quote"], preview["fulfilment"]
        lines = []
        for line in quote["lines"]:
            options = ", ".join(line["options"])
            lines.append(f'{line["qty"]} × {line["name"]}' + (f" ({options})" if options else ""))
        date = fulfilment.get("date") or quote["location"]["opens"][:10]
        year, month, day = (int(part) for part in date.split("-"))
        if not 1 <= month <= 12 or not 1 <= day <= 31:
            raise ValueError("approval_card_invalid")
        when = f"{day} {MONTHS[month - 1]} {year}"
        where = quote["location"]["name"] if fulfilment["type"] == "pickup" else "Delivery to " + fulfilment["deliveryAddress"]
        fields = {"order": "; ".join(lines), "total": f'₹{quote["totalInr"]}, {PAYMENT_WORDS[preview["paymentMethod"]]}',
                  "pickup": f"{where} · {when}", "name": preview["displayName"]}
        if preview.get("note", "") != "":
            fields[CARD_NOTE_KEY] = preview["note"]
        parts = [line["name"] for line in quote["lines"]] + [o for line in quote["lines"] for o in line["options"]]
        parts += [quote["location"]["name"]] if fulfilment["type"] == "pickup" else [fulfilment["deliveryAddress"]]
        if any(_card_ambiguous(part) for part in parts):
            raise ValueError("approval_card_not_minimal")
    except (KeyError, TypeError, IndexError, AttributeError) as error:
        raise ValueError("approval_card_invalid") from error
    if not all(card_value_fits(value) for value in fields.values()):
        raise ValueError("approval_card_not_minimal")
    return fields

def is_flat(payload):
    """The flat card's shape: the four rows, plus the note row when the order has a note."""
    return isinstance(payload, dict) and set(payload) in (CARD_KEYS, CARD_KEYS | {CARD_NOTE_KEY})

def _checked_preview(preview, draft_id):
    if not isinstance(preview, dict) or set(preview) not in (PREVIEW_KEYS, PREVIEW_KEYS | {"note"}) or preview["appId"] != "forkicks" or preview["draftId"] != draft_id:
        raise ValueError("approval_preview_unavailable")
    return preview

def checked_payload(payload, draft_id, expected_hash, preview=None):
    """The app's payload, checked; `preview` is the order the app returned beside a CARD_KEYS payload."""
    if is_flat(payload):
        if card_fields(_checked_preview(preview, draft_id)) != payload:
            raise ValueError("approval_card_invalid")
    elif isinstance(payload, dict) and set(payload) == LEGACY_KEYS and payload["appId"] == "forkicks" and payload["operation"] == "forkicks.order.confirm":
        _checked_preview(payload["preview"], draft_id)
    else:
        raise ValueError("approval_preview_unavailable")
    held = canonical(payload)
    if len(held.encode("utf-8")) > MAX_PAYLOAD_BYTES or hashlib.sha256(held.encode("utf-8")).hexdigest() != expected_hash:
        raise ValueError("approval_preview_unavailable")
    return held

def order_preview(record):
    """The saved order behind a record: inside a legacy payload, beside a flat one."""
    payload = record["payload"]
    return record["preview"] if is_flat(payload) else payload["preview"]

def cache_path(home: Path, draft_id):
    if not isinstance(draft_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", draft_id):
        raise ValueError("invalid_draft")
    folder = home / "forkicks-drafts"
    path = folder / (draft_id + ".json")
    if any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError("approval_preview_unavailable")
    return path

def save_preview(home, result, context, config):
    if not isinstance(result, dict) or result.get("error") or not result.get("draftId"):
        return  # A refused quote has no draft and cannot be confirmed.
    payload = result.get("approvalPayload")
    flat = is_flat(payload)
    # The order behind a flat payload is the app's own `preview` beside it in this prepare answer (never the agent's).
    held = checked_payload(payload, result["draftId"], result.get("payloadHash"), result.get("preview") if flat else None)
    path = cache_path(home, result["draftId"])
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    record = {"payload": json.loads(held), "payloadHash": result["payloadHash"], "owner": config["ownerTelegramId"],
              "origin": config["origin"], "session": context["SESSION_KEY"], "message": context["MESSAGE_ID"],
              **({"preview": result["preview"]} if flat else {})}
    data = canonical(record).encode("utf-8")
    # O_EXCL keeps the first immutable preview/turn across retries; a prepare replay cannot move its consent boundary.
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        previous = load_preview(home, result["draftId"], config)
        if previous["payloadHash"] != result["payloadHash"]:
            raise ValueError("approval_preview_unavailable")
        return
    with os.fdopen(fd, "wb") as handle:
        handle.write(data)

def load_preview(home, draft_id, config):
    path = cache_path(home, draft_id)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > 65536:
            raise ValueError("approval_preview_unavailable")
        record = json.load(handle)
    if record.get("owner") != config["ownerTelegramId"] or record.get("origin") != config["origin"]:
        raise ValueError("approval_preview_unavailable")
    checked_payload(record.get("payload"), draft_id, record.get("payloadHash"), record.get("preview"))
    return record

def authorize_order(record, draft_id):
    payload = record["payload"]
    held = checked_payload(payload, draft_id, record["payloadHash"], record.get("preview"))
    key = APPROVAL_CLASS + ":forkicks.order.confirm:" + draft_id
    try:
        summary = approval_summary({"preview": order_preview(record)})
    except ValueError as error:
        return None, {"error": str(error)}
    ap = approval_modules()
    # The app's payload, byte for byte (its confirm compares it with the stored one): the box only checks it.
    answer = ap.propose(APPROVAL_CLASS, key, summary, held)
    task = answer.doc.get("task")
    # Purchases ALWAYS require a human grant, even when Gold Stars uses autonomous policy.
    if not answer.ok or not isinstance(task, str) or not re.fullmatch(r"propose:[a-f0-9]{32}", task) or answer.doc.get("payload_hash") != record["payloadHash"] or answer.doc.get("decision") != "requested":
        return None, {"error": "approval_refused"}
    proof = {"taskId": task, "payloadHash": record["payloadHash"], "payload": payload}
    if answer.doc.get("state") == "executed":
        return proof, None  # The CP re-reads the direct grant/start; same draft is merchant-idempotent.
    granted = ap.wait(task)
    if granted.exit_code != 0 or granted.status != "granted":
        return None, {"error": "approval_required", "instruction": ORDER_APPROVE_IN_BOT}
    started = ap.start(task, key, held)
    if not started.ok or started.doc.get("authorization") != "grant":
        return None, {"error": "approval_not_started"}
    return proof, None
