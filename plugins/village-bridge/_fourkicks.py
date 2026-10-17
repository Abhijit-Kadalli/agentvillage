"""Persist server previews, not model-supplied purchase proofs. The app/CP are authority."""
from __future__ import annotations
import hashlib
import json
import os
import re
import stat
from pathlib import Path
from ._mini_apps import approval_modules, ORDER_APPROVE_IN_BOT

MAX_PAYLOAD_BYTES = 60000

def canonical(payload):
    return json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)

def checked_payload(payload, draft_id, expected_hash):
    if not isinstance(payload, dict) or set(payload) != {"appId", "operation", "preview"} or payload["appId"] != "fourkicks" or payload["operation"] != "fourkicks.order.confirm":
        raise ValueError("approval_preview_unavailable")
    preview = payload["preview"]
    keys = {"appId", "draftId", "quote", "displayName", "items", "fulfilment", "paymentMethod"}
    if not isinstance(preview, dict) or set(preview) not in (keys, keys | {"note"}) or preview["appId"] != "fourkicks" or preview["draftId"] != draft_id:
        raise ValueError("approval_preview_unavailable")
    held = canonical(payload)
    if len(held.encode("utf-8")) > MAX_PAYLOAD_BYTES or hashlib.sha256(held.encode("utf-8")).hexdigest() != expected_hash:
        raise ValueError("approval_preview_unavailable")
    return held

def cache_path(home: Path, draft_id):
    if not isinstance(draft_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", draft_id):
        raise ValueError("invalid_draft")
    folder = home / "fourkicks-drafts"
    path = folder / (draft_id + ".json")
    if any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError("approval_preview_unavailable")
    return path

def save_preview(home, result, context, config):
    if not isinstance(result, dict) or result.get("error") or not result.get("draftId"):
        return  # A refused quote has no draft and cannot be confirmed.
    held = checked_payload(result.get("approvalPayload"), result["draftId"], result.get("payloadHash"))
    path = cache_path(home, result["draftId"])
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    record = {"payload": json.loads(held), "payloadHash": result["payloadHash"], "owner": config["ownerTelegramId"],
              "origin": config["origin"], "session": context["SESSION_KEY"], "message": context["MESSAGE_ID"]}
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
    checked_payload(record.get("payload"), draft_id, record.get("payloadHash"))
    return record

def authorize_order(record, draft_id):
    payload = record["payload"]
    held = checked_payload(payload, draft_id, record["payloadHash"])
    key = "marketplace.app.action:fourkicks.order.confirm:" + draft_id
    ap = approval_modules()
    preview = payload["preview"]
    summary = "Four Kicks order: ₹" + str(preview["quote"].get("totalInr")) + "; café name: " + str(preview["displayName"])
    answer = ap.propose("marketplace.app.action", key, summary, held)
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
