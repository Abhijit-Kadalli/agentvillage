"""The ONE generic approval card (mini-apps v2 Phase 1 item 6): any catalog app's `needs-card` operation gets the For
Kicks minimal card, four plain strings re-derived on the box from the app's saved preview through the op's manifest
`approval.card` declaration, then the For Kicks authorize path generalised.

Contract (CARD-COMMON, design MINIAPPS-PLATFORM-v2 section 3): spec + golden vectors in
tests/vectors/mini-app-card.{md,json} (byte-identical copies in the app and the control plane).

- The four strings: `card_fields(declaration, preview, request=None)`; the fit rules are For Kicks' own
  (`card_value_fits`, `card_name_fakes_line`, imported, never copied). A string that does not fit is refused, never cut.
- Class and key (CARD-COMMON item 3; Carter L19773, approval L19771): the parent `marketplace.app.action` is autonomous for
  everyone, so a needs-card op proposes under its MEMBER class `marketplace.app.action.<operation>` (the operation's full
  name, whose first segment is the app id: the gold-stars.send member row's shape) with key `<class>:<draftId>`. The
  decision must be `requested` (approval pins that member row to ask when the app is reviewed); `autonomous` (no row yet)
  is refused `approval_card_unpinned` and nothing runs: a payment never runs without its card.
- The draft cache: `$HERMES_HOME/mini-apps/drafts/<appId>/<draftId>.json`, 0600, O_EXCL, owner + origin + hash, no links.
- How the box learns an op's class and card: from an op RECORD in the projection, `{"name", "class", "prepare"?, "card"?}`
  (`projected_operation`). The v1 projection (`mini-apps.json` version 1) carries operation NAMES only, and the cp's
  v1Entry refuses any non-read op of a generic app (`relay_non_read_op`), so on every box today no op has a class here and
  every generic path below is dark: `projected_app` returns None until a projection that carries op records exists.

For Kicks' module (`_forkicks.py`, `_forkicks_grant.py`) is not changed by this train.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import unicodedata
from pathlib import Path

from ._forkicks import (CARD_VALUE_MAX, SUMMARY_HTML_MAX_BYTES, SUMMARY_MAX_BYTES, canonical, card_name_fakes_line,
                        card_value_fits)
from ._mini_apps import approval_modules

PARENT_CLASS = "marketplace.app.action"
SHOWN = ("item", "total", "when", "shared")
CARD_KEYS = frozenset(SHOWN)
DECLARATION_KEYS = frozenset((*SHOWN, "bind"))
SEGMENT = r"[A-Za-z_][A-Za-z0-9_]{0,63}"
PATH = re.compile(SEGMENT + r"(?:\." + SEGMENT + r"){0,7}")
SEGMENT_RE = re.compile(SEGMENT)
#: Bound by the approval key and the per-draft record; never shown or bound by a declaration, skipped by coverage.
RESERVED = frozenset({"appId", "draftId"})
BIND_MAX = 32
DEPTH_MAX = 16
#: The four rows' labels in the propose summary (approval L19771). The card's own row labels are the cp template's say entry.
LABELS = {"item": "What", "total": "Total", "when": "When & where", "shared": "Shared with"}
CARD_ERRORS = frozenset({"approval_card_invalid", "approval_card_not_minimal", "approval_card_too_long", "approval_card_undeclared"})

APP_ID = re.compile(r"[a-z][a-z0-9-]{0,39}")
OPERATION = re.compile(r"[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){1,3}")
DRAFT_ID = re.compile(r"[A-Za-z0-9_-]{1,100}")
TASK = re.compile(r"propose:[a-f0-9]{32}")
HASH = re.compile(r"[0-9a-f]{64}")
#: Apps with their own reviewed path in this overlay: never routed through the generic card (they flip in a later PR).
REVIEWED_APPS = frozenset({"gold-stars", "forkicks", "zzzbot", "slopfolio", "mini-app"})
GENERIC_CLASSES = frozenset({"prepare", "needs-card"})
OP_RECORD_KEYS = frozenset({"name", "class", "prepare", "card", "maxRequestBytes", "timeoutMs", "framing"})
MAX_PAYLOAD_BYTES = 60000
RECORD_MAX_BYTES = 131072

# ---- product owns the words ------------------------------------------------------------------------------------------
# Every resident-facing line and agent-facing instruction of the generic card, in one place. Lines are filled only from
# the projection's app name and the app's confirm answer (`receipt.summary`), never from agent text.
APP_NAME_FALLBACK = "mini-app"
PLACED_LINE = "Approved: your {appName} action is placed."
PLACED_LINE_RECEIPT = "Approved: your {appName} action is placed: {receipt}."
NOT_PLACED_LINE = "Your {appName} action wasn't placed: {reason}."
REASONS = {
    "denied": "the approval was declined",
    "withdrawn": "the approval request was withdrawn",
    "expired": "the approval or the draft expired",
    "failed": "the app couldn't take it",
}
ACTION_APPROVE_IN_BOT = ("Ask the owner to approve this exact action on its card in the approvals bot, then retry the same "
                         "operation with this SAME draftId. Never prepare another draft to retry an uncertain confirm.")
ACTION_PLACED_ON_APPROVAL = ("The approval card for this exact action is in the owner's approvals bot. Tell the owner: "
                             "\"I'll do it as soon as you approve.\" When they approve, it runs automatically and they get a "
                             "message in this chat; never ask them to approve or confirm here, and never claim it was done "
                             "before a receipt. If they ask later, retry the same operation with this SAME draftId; never "
                             "prepare another draft.")
ACTION_UNPINNED = ("This action has no approval card set up yet, so it cannot run. Nothing was done. Tell the owner the app "
                   "is not ready for this yet; never retry it or work around it.")
ACTION_CARD_REFUSED = ("This draft cannot be shown whole on a plain approval card, so it cannot be confirmed. Nothing was "
                       "done. Tell the owner; do not retry it or prepare it again in another form.")
ACTION_UNCLEAR = ("Do not claim it was done. To retry a confirm, use the SAME draftId; never prepare another draft after an "
                  "uncertain confirm.")
ACTION_CONFIRMATION_REQUIRED = "Show the exact saved preview and wait for a new owner reply confirming it."
ACTION_CONFIRM_IN_PROGRESS = ("That action is already being confirmed. Wait about two minutes, then confirm the SAME draft "
                              "again: if it went through you get the same receipt. Never prepare a new draft for it.")
# ---- end of product's words ------------------------------------------------------------------------------------------


def member_class(operation: str) -> str:
    return PARENT_CLASS + "." + operation


def action_key(operation: str, draft_id: str) -> str:
    return member_class(operation) + ":" + draft_id


# ---- the four strings --------------------------------------------------------------------------------------------------


def _segments(path):
    return tuple(path.split("."))


def _check_declaration(declaration):
    """The declaration's shown paths (in SHOWN order) and bind pairs, as segment tuples; or a card error."""
    if declaration is None:
        raise ValueError("approval_card_undeclared")
    if not isinstance(declaration, dict) or set(declaration) != DECLARATION_KEYS:
        raise ValueError("approval_card_invalid")
    shown = []
    for key in SHOWN:
        path = declaration[key]
        if not isinstance(path, str) or not PATH.fullmatch(path):
            raise ValueError("approval_card_invalid")
        shown.append(_segments(path))
    bind = declaration["bind"]
    if not isinstance(bind, list) or len(bind) > BIND_MAX:
        raise ValueError("approval_card_invalid")
    pairs = []
    for pair in bind:
        if (not isinstance(pair, list) or len(pair) != 2 or not all(isinstance(p, str) and PATH.fullmatch(p) for p in pair)):
            raise ValueError("approval_card_invalid")
        pairs.append((_segments(pair[0]), _segments(pair[1])))
    for path in (*shown, *(previewPath for _, previewPath in pairs)):
        if path[0] in RESERVED:
            raise ValueError("approval_card_invalid")
    for i, a in enumerate(shown):
        for b in shown[i + 1:]:
            if a[:len(b)] == b or b[:len(a)] == a:  # equal, or one under the other
                raise ValueError("approval_card_invalid")
    return shown, pairs


_MISSING = object()


def _resolve(value, path):
    for segment in path:
        if not isinstance(value, dict) or segment not in value:
            return _MISSING
        value = value[segment]
    return value


def _leaves(value, prefix, depth):
    """Every leaf path of an object (objects are descended; everything else, and an empty object, is a leaf)."""
    if depth > DEPTH_MAX:
        raise ValueError("approval_card_invalid")
    for key, child in value.items():
        if not isinstance(key, str) or not SEGMENT_RE.fullmatch(key):
            raise ValueError("approval_card_invalid")
        path = (*prefix, key)
        if isinstance(child, dict) and child:
            yield from _leaves(child, path, depth + 1)
        else:
            yield path


def _text_ok(value, lines):
    return not any(unicodedata.category(c) in {"Cc", "Cf", "Cs", "Zl", "Zp"} and not (lines and c == "\n") for c in value)


def _fits(key, value):
    lines = key == "item"
    if not card_value_fits(value, lines=lines) or not value.strip(" "):
        return False
    if lines and (any(not line.strip(" ") for line in value.split("\n")) or card_name_fakes_line(value)):
        return False
    return True


def card_fields(declaration, preview, request=None):
    """The four strings of the generic minimal card {item, total, when, shared}, or ValueError(<card code>).
    `request` (the prepare op's arguments) checks every bind pair; the control plane, which has none, passes None.
    Mirrored byte for byte by the app and the cp; check order and codes: tests/vectors/mini-app-card.md."""
    shown, pairs = _check_declaration(declaration)
    if not isinstance(preview, dict):
        raise ValueError("approval_card_invalid")
    fields = {}
    for key, path in zip(SHOWN, shown):
        value = _resolve(preview, path)
        if not isinstance(value, str):
            raise ValueError("approval_card_invalid")
        fields[key] = value
    for request_path, preview_path in pairs:
        bound = _resolve(preview, preview_path)
        if bound is _MISSING:
            raise ValueError("approval_card_invalid")
        if request is not None:
            sent = _resolve(request, request_path) if isinstance(request, dict) else _MISSING
            if sent is _MISSING or canonical(sent) != canonical(bound):
                raise ValueError("approval_card_invalid")
    shown_set = set(shown)
    bound_paths = [preview_path for _, preview_path in pairs]
    top = {key: value for key, value in preview.items() if key not in RESERVED}
    for leaf in _leaves(top, (), 1):
        if leaf not in shown_set and not any(leaf[:len(b)] == b for b in bound_paths):
            raise ValueError("approval_card_invalid")
    for key in SHOWN:
        if not _text_ok(fields[key], key == "item"):
            raise ValueError("approval_card_invalid")
    for key in SHOWN:
        if not _fits(key, fields[key]):
            raise ValueError("approval_card_not_minimal")
    card_summary(fields)
    return fields


def card_summary(fields):
    """The text the box proposes beside the payload (the technical card's Full details), within For Kicks' budget."""
    summary = "\n".join(f"{LABELS[key]}: {fields[key]}" for key in SHOWN)
    escaped = summary.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    if len(summary.encode("utf-8")) > SUMMARY_MAX_BYTES or len(escaped.encode("utf-8")) > SUMMARY_HTML_MAX_BYTES:
        raise ValueError("approval_card_too_long")
    return summary


def unframe(result, app_id, operation):
    """The app's answer inside the dispatcher's frame `{kind: "mini-app", appId, operation, asOf, result}` (design 2.1.5),
    or the answer itself when unframed. A frame naming another app or operation is refused."""
    if isinstance(result, dict) and result.get("kind") == "mini-app":
        if result.get("appId") != app_id or result.get("operation") != operation or not isinstance(result.get("result"), dict):
            return {"error": "mini_app_frame_mismatch"}
        return result["result"]
    return result


def payload_hash(fields) -> str:
    return hashlib.sha256(canonical(fields).encode("utf-8")).hexdigest()


def checked_payload(payload, expected_hash, declaration, preview, request=None):
    """The app's four-string payload, re-derived here from its own saved preview and refused on any difference; the
    canonical bytes the daemon holds."""
    if not isinstance(payload, dict) or set(payload) != CARD_KEYS:
        raise ValueError("approval_preview_unavailable")
    if card_fields(declaration, preview, request) != payload:
        raise ValueError("approval_card_invalid")
    held = canonical(payload)
    if (not isinstance(expected_hash, str) or not HASH.fullmatch(expected_hash) or len(held.encode("utf-8")) > MAX_PAYLOAD_BYTES
            or hashlib.sha256(held.encode("utf-8")).hexdigest() != expected_hash):
        raise ValueError("approval_preview_unavailable")
    return held


# ---- the projection: how the box learns an op's class and card -------------------------------------------------------


def projected_app(home: Path, app_id: str):
    """The projection's entry for `app_id` with its op RECORDS, `{"id", "name"?, "operations": [{"name", "class", ...}]}`,
    or None. FINDING (CARD-OV): the v1 projection carries op NAMES only (`installed()` checks `{id, version, skills,
    operations}` by exact equality, and the cp's v1Entry throws `relay_non_read_op` for a generic app with any non-read op),
    so no box can learn a class or a card today: this returns None for every projection, and the generic path is dark.
    The cp's signed v2 projection (design 2.2-2.3) plugs in here; until then nothing reads a class from disk."""
    return None


def operation_record(app, operation):
    """The op record `{name, class, prepare?, card?}` a projected app carries for `operation`, checked; or None."""
    if not isinstance(app, dict) or not isinstance(app.get("operations"), list):
        return None
    found = [op for op in app["operations"] if isinstance(op, dict) and op.get("name") == operation]
    if len(found) != 1:
        return None
    record = found[0]
    if not set(record) <= OP_RECORD_KEYS or record.get("class") not in GENERIC_CLASSES:
        return None
    if record["class"] == "needs-card" and (not isinstance(record.get("prepare"), str) or not OPERATION.fullmatch(record["prepare"])):
        return None
    return record


def projected_operation(home: Path, operation):
    """`(appId, app entry, op record)` for a generic prepare / needs-card op, or None (every v1 projection)."""
    if not isinstance(operation, str) or not OPERATION.fullmatch(operation):
        return None
    app_id = operation.split(".", 1)[0]
    if app_id in REVIEWED_APPS or not APP_ID.fullmatch(app_id):
        return None
    app = projected_app(home, app_id)
    if not isinstance(app, dict) or app.get("id") != app_id:
        return None
    record = operation_record(app, operation)
    return None if record is None else (app_id, app, record)


def card_operation_for(app, prepare):
    """The one needs-card op of `app` whose `prepare` is this op, or None (no card declared for it)."""
    if not isinstance(app, dict) or not isinstance(app.get("operations"), list):
        return None
    found = [op for op in app["operations"] if isinstance(op, dict) and op.get("class") == "needs-card" and op.get("prepare") == prepare]
    return found[0] if len(found) == 1 and operation_record(app, found[0].get("name")) is not None else None


def app_name(app):
    """The app's display name for the line (letters, digits, spaces and plain punctuation, at most 40), or the fallback."""
    name = app.get("name") if isinstance(app, dict) else None
    if isinstance(name, str):
        kept = " ".join("".join(ch for ch in name if ch.isalnum() or ch in " .'&-").split())
        if kept and len(kept) <= 40 and "media:" not in kept.lower():
            return kept
    return APP_NAME_FALLBACK


# ---- the draft cache ---------------------------------------------------------------------------------------------------


def drafts_root(home: Path) -> Path:
    return home / "mini-apps" / "drafts"


def cache_path(home: Path, app_id, draft_id):
    if not isinstance(app_id, str) or not APP_ID.fullmatch(app_id) or app_id in REVIEWED_APPS:
        raise ValueError("invalid_app")
    if not isinstance(draft_id, str) or not DRAFT_ID.fullmatch(draft_id):
        raise ValueError("invalid_draft")
    path = drafts_root(home) / app_id / (draft_id + ".json")
    if any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError("approval_preview_unavailable")
    return path


def _expires_ok(value):
    return value is None or (isinstance(value, str) and len(value) <= 64)


def save_preview(home, app_id, prepare, card_op, result, request, context, config):
    """Save the app's prepare answer for its needs-card op, after re-deriving the four strings from the app's preview
    (and checking every bind against the request this box sent). O_EXCL: the first preview of a draft is immutable."""
    if not isinstance(result, dict) or result.get("error") or not result.get("draftId"):
        return None  # a refused prepare has no draft and cannot be confirmed
    draft_id = result["draftId"]
    declaration = card_op.get("card") if isinstance(card_op, dict) else None
    preview = result.get("preview")
    if isinstance(preview, dict) and (preview.get("appId", app_id) != app_id or preview.get("draftId", draft_id) != draft_id):
        raise ValueError("approval_preview_unavailable")
    held = checked_payload(result.get("approvalPayload"), result.get("payloadHash"), declaration, preview, request)
    if not _expires_ok(result.get("expiresAt")):
        raise ValueError("approval_preview_unavailable")
    path = cache_path(home, app_id, draft_id)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    record = {"appId": app_id, "prepare": prepare, "operation": card_op["name"], "payload": json.loads(held),
              "payloadHash": result["payloadHash"], "preview": preview, "request": request,
              "owner": config["ownerTelegramId"], "origin": config["origin"],
              "session": context["SESSION_KEY"], "message": context["MESSAGE_ID"],
              **({"expiresAt": result["expiresAt"]} if result.get("expiresAt") is not None else {})}
    data = canonical(record).encode("utf-8")
    if len(data) > RECORD_MAX_BYTES:
        raise ValueError("approval_preview_unavailable")
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        previous = load_preview(home, app_id, draft_id, config, card_op)
        if previous["payloadHash"] != result["payloadHash"]:
            raise ValueError("approval_preview_unavailable")
        return previous
    with os.fdopen(fd, "wb") as handle:
        handle.write(data)
    return record


def load_preview(home, app_id, draft_id, config, card_op):
    """A draft this box saved, for this owner and origin and this needs-card op, re-checked against its declaration."""
    path = cache_path(home, app_id, draft_id)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > RECORD_MAX_BYTES:
            raise ValueError("approval_preview_unavailable")
        record = json.load(handle)
    if (not isinstance(record, dict) or record.get("owner") != config["ownerTelegramId"] or record.get("origin") != config["origin"]
            or record.get("appId") != app_id or not isinstance(card_op, dict) or record.get("operation") != card_op.get("name")
            or record.get("prepare") != card_op.get("prepare")):
        raise ValueError("approval_preview_unavailable")
    checked_payload(record.get("payload"), record.get("payloadHash"), card_op.get("card"), record.get("preview"), record.get("request"))
    return record


# ---- authorize ---------------------------------------------------------------------------------------------------------


def authorize_action(record, app_id, operation, draft_id, declaration, on_requested=None):
    """`authorize_order` generalised: propose the op's member class with the four-string payload, require `requested`
    (a human card), read the decision once, start with `authorization: grant`. `(proof, None)` or `(None, refusal)`."""
    if (not isinstance(record, dict) or record.get("appId") != app_id or record.get("operation") != operation
            or not isinstance(operation, str) or operation.split(".", 1)[0] != app_id):
        return None, {"error": "approval_preview_unavailable"}
    try:
        held = checked_payload(record.get("payload"), record.get("payloadHash"), declaration, record.get("preview"), record.get("request"))
        summary = card_summary(record["payload"])
    except ValueError as error:
        return None, {"error": str(error)}
    key = action_key(operation, draft_id)
    ap = approval_modules()
    answer = ap.propose(member_class(operation), key, summary, held)
    task = answer.doc.get("task")
    if not answer.ok or not isinstance(task, str) or not TASK.fullmatch(task) or answer.doc.get("payload_hash") != record["payloadHash"]:
        return None, {"error": "approval_refused"}
    decision = answer.doc.get("decision")
    if decision == "autonomous":
        # No member row pins this op to ask: the parent class is autonomous, so a start here would spend money with no
        # card. Fail closed (CARD-COMMON item 3): nothing is started, nothing is sent to the app.
        return None, {"error": "approval_card_unpinned", "instruction": ACTION_UNPINNED}
    if decision != "requested":
        return None, {"error": "approval_refused"}
    proof = {"taskId": task, "payloadHash": record["payloadHash"], "payload": record["payload"]}
    if answer.doc.get("state") == "executed":
        return proof, None  # an earlier start of this draft: the cp re-reads the grant; the app replays its receipt
    granted = ap.wait(task)
    if granted.exit_code != 0 or granted.status != "granted":
        tracked = on_requested(task) if on_requested is not None and granted.exit_code == 6 else None
        return None, {"error": "approval_required", "instruction": tracked or ACTION_APPROVE_IN_BOT}
    started = ap.start(task, key, held)
    if not started.ok or started.doc.get("authorization") != "grant":
        return None, {"error": "approval_not_started"}
    return proof, None
