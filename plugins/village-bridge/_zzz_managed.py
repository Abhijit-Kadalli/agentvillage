"""Bounded, box-local ZZZ pair polling for the installer-owned Hermes cron.

The app and ZZZ remain the authority for the current pair and every operation.
This file keeps only cursors, IDs and a short reply reservation; no post text.
"""
from __future__ import annotations

import fcntl
import json
import os
import re
import stat
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

JOB_NAME = "Edge — zzz pairs"
JOB_SCRIPT = "agentvillage_zzz_pairs.sh"
JOB_TOOLSETS = ["village", "no_mcp"]
STATE_LIMIT = 65536
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,199}\Z")
CRON_SESSION = re.compile(r"cron_([0-9a-f]{12})_[0-9]{8}_[0-9]{6}\Z")
CRON_TASK = re.compile(r"cron:([0-9a-f]{12}):[0-9a-f-]{8,80}\Z")
CRON_OPS = frozenset(("zzz.pairs", "zzz.changes", "zzz.read_thread", "zzz.reply", "zzz.create_thread"))
INTRO_TITLE = "Hello from this side"
INTRO_BODY = "Hello! I'm this resident's agent. What would be useful to coordinate here?"


def _plain_json(path: Path, limit: int):
    if any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError("symlink")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        meta = os.fstat(stream.fileno())
        if not stat.S_ISREG(meta.st_mode) or meta.st_size > limit:
            raise ValueError("size")
        return json.load(stream)


def managed_context(home: Path, operation: str, session_id: object, task_id: object):
    """A Hermes-created cron root for our enabled job; IDs are handler kwargs, never model fields.

    Hermes v2026.9.24 cron/scheduler.py _CronRunScope deliberately clears
    HERMES_SESSION_KEY/PLATFORM; model_tools.py injects session_id and task_id
    into registry handler kwargs from the live agent/tool executor.
    """
    if operation not in CRON_OPS:
        return None
    try:
        from gateway import session_context as sc
        from agent.delegation_context import is_delegated_child_context
        if is_delegated_child_context():
            return None
        if sc._VAR_MAP["HERMES_CRON_SESSION"].get() != "1":
            return None
        match = CRON_SESSION.fullmatch(session_id) if isinstance(session_id, str) else None
        task = CRON_TASK.fullmatch(task_id) if isinstance(task_id, str) else None
        if not match or not task or match[1] != task[1]:
            return None
        jobs = _plain_json(home / "cron" / "jobs.json", 1024 * 1024)
        if not isinstance(jobs, dict) or not isinstance(jobs.get("jobs"), list):
            return None
        good = [job for job in jobs["jobs"] if isinstance(job, dict) and job.get("id") == match[1]
                and job.get("name") == JOB_NAME and job.get("script") == JOB_SCRIPT
                and job.get("enabled") is True and job.get("no_agent") is not True
                and job.get("enabled_toolsets") == JOB_TOOLSETS]
        if len(good) != 1:
            return None
        config = _plain_json(home / "village-bridge.json", 2048)
        owner = config.get("ownerTelegramId") if isinstance(config, dict) else None
        if not isinstance(owner, str) or not re.fullmatch(r"[1-9][0-9]{0,19}", owner):
            return None
        return {"SESSION_KEY": session_id, "MESSAGE_ID": task_id, "USER_ID": owner,
                "MANAGED_ZZZ": True}
    except Exception:
        return None


def _state_path(home: Path) -> Path:
    return home / "zzzbot" / "managed-pairs.json"


@contextmanager
def locked_state(home: Path):
    folder = home / "zzzbot"
    if any(p.is_symlink() for p in (folder, *folder.parents)):
        raise ValueError("symlink")
    folder.mkdir(mode=0o700, exist_ok=True)
    lock = folder / "managed-pairs.lock"
    fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "r+") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        path = _state_path(home)
        try:
            state = _plain_json(path, STATE_LIMIT)
            if not isinstance(state, dict) or state.get("version") != 1:
                raise ValueError("state")
        except FileNotFoundError:
            state = {"version": 1, "rooms": {}, "pending": None, "day": "", "replies": 0,
                     "failures": 0, "retryAt": 0}
        yield state
        data = json.dumps(state, separators=(",", ":")).encode()
        if len(data) > STATE_LIMIT:
            raise ValueError("state-size")
        temp = folder / (".managed-" + str(os.getpid()))
        tfd = os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(tfd, "wb") as target:
                target.write(data)
                target.flush()
                os.fsync(target.fileno())
            os.replace(temp, path)
        finally:
            if temp.exists():
                temp.unlink()


def current_pairs(transport, config):
    result = transport(config, {"operation": "zzz.pairs"})
    if not isinstance(result, dict) or result.get("kind") != "zzz.pairs" or not isinstance(result.get("pairs"), list):
        raise ValueError("pairs")
    if len(result["pairs"]) > 20:
        raise ValueError("pairs-limit")
    pairs = {}
    for pair in result["pairs"]:
        if not isinstance(pair, dict) or pair.get("status") != "agent_messaging_enabled":
            raise ValueError("pair")
        room, request, epoch = pair.get("roomId"), pair.get("requestId"), pair.get("consentEpoch")
        if not isinstance(room, str) or not ID.fullmatch(room) or not isinstance(request, str) or not ID.fullmatch(request) or type(epoch) is not int or epoch < 1:
            raise ValueError("pair")
        if room in pairs:
            raise ValueError("pair-duplicate")
        pairs[room] = {"requestId": request, "consentEpoch": epoch}
    return pairs


def reserve_reply(home: Path, transport, config, thread: str) -> bool:
    """One pending exact thread, current pair, two replies per UTC day max."""
    if not isinstance(thread, str) or not ID.fullmatch(thread):
        return False
    try:
        pairs = current_pairs(transport, config)
        with locked_state(home) as state:
            pending = state.get("pending")
            today = datetime.now(timezone.utc).date().isoformat()
            if state.get("day") != today:
                state["day"], state["replies"] = today, 0
            if (not isinstance(pending, dict) or pending.get("kind") != "incoming"
                    or pending.get("threadId") != thread or state.get("replies", 0) >= 2):
                return False
            room = pending.get("roomId")
            if pairs.get(room) != {"requestId": pending.get("requestId"), "consentEpoch": pending.get("consentEpoch")}:
                state["pending"] = None
                return False
            if datetime.now(timezone.utc).timestamp() - pending.get("at", 0) > 1800:
                state["pending"] = None
                return False
            state["pending"] = None  # consume before network; uncertain writes are never repeated
            state["replies"] += 1
            return True
    except Exception:
        return False


def reserve_bootstrap(home: Path, transport, config, room: str):
    """Consume one empty-room invitation before writing; return a stable epoch key.

    A timeout after reservation sacrifices delivery rather than duplicating an
    introduction. The app also deduplicates the deterministic turn ID.
    """
    if not isinstance(room, str) or not ID.fullmatch(room):
        return None
    try:
        pairs = current_pairs(transport, config)
        with locked_state(home) as state:
            pending = state.get("pending")
            today = datetime.now(timezone.utc).date().isoformat()
            if state.get("day") != today:
                state["day"], state["replies"] = today, 0
            if (not isinstance(pending, dict) or pending.get("kind") != "bootstrap"
                    or pending.get("roomId") != room or state.get("replies", 0) >= 2):
                return None
            identity = {"requestId": pending.get("requestId"), "consentEpoch": pending.get("consentEpoch")}
            if pairs.get(room) != identity or datetime.now(timezone.utc).timestamp() - pending.get("at", 0) > 1800:
                state["pending"] = None
                return None
            changes = transport(config, {"operation": "zzz.changes", "room": room, "after": "0", "limit": 1})
            if (not isinstance(changes, dict) or changes.get("kind") != "zzz.changes"
                    or changes.get("items") != [] or changes.get("nextCursor")):
                state["pending"] = None
                return None
            state["pending"] = None
            state["replies"] += 1
            return str(uuid.uuid5(uuid.NAMESPACE_URL, json.dumps(
                ["zzz-pair-intro", room, identity["requestId"], identity["consentEpoch"]])))
    except Exception:
        return None


def allow_managed_read(home: Path, transport, config, operation: str, target: str) -> bool:
    """Managed cron reads stay in current pairs; a thread read is exact-pending."""
    try:
        pairs = current_pairs(transport, config)
        if operation == "zzz.changes":
            return target in pairs
        if operation != "zzz.read_thread":
            return False
        with locked_state(home) as state:
            pending = state.get("pending")
            if not isinstance(pending, dict) or pending.get("threadId") != target:
                return False
            room = pending.get("roomId")
            return (pairs.get(room) == {"requestId": pending.get("requestId"),
                                        "consentEpoch": pending.get("consentEpoch")}
                    and datetime.now(timezone.utc).timestamp() - pending.get("at", 0) <= 1800)
    except Exception:
        return False


def poll(home: Path, transport, config, installed):
    """Return at most one ID-only wake. First encounter drains history as baseline."""
    if not installed(home, "zzzbot", "zzz.list_rooms"):
        return None
    with locked_state(home) as state:
        now = datetime.now(timezone.utc).timestamp()
        if state.get("retryAt", 0) > now:
            return None
        try:
            pairs = current_pairs(transport, config)
            rooms = state.get("rooms", {})
            if not isinstance(rooms, dict):
                raise ValueError("rooms")
            # A removed or newly consented pair cannot inherit an old cursor or pending reply.
            rooms = {room: value for room, value in rooms.items()
                     if room in pairs and isinstance(value, dict)
                     and value.get("requestId") == pairs[room]["requestId"]
                     and value.get("consentEpoch") == pairs[room]["consentEpoch"]}
            pending = state.get("pending")
            if isinstance(pending, dict) and (pending.get("roomId") not in pairs or
                pairs[pending["roomId"]] != {"requestId": pending.get("requestId"), "consentEpoch": pending.get("consentEpoch")}):
                state["pending"] = None
            elif isinstance(pending, dict):
                if now - pending.get("at", 0) <= 1800:
                    state["rooms"] = rooms
                    return None
                state["pending"] = None
            event = None
            saw_item = False
            inspected = 0
            all_pairs = list(pairs.items())
            offset = state.get("nextPair", 0)
            if type(offset) is not int or offset < 0:
                offset = 0
            selected = [all_pairs[(offset + i) % len(all_pairs)] for i in range(min(2, len(all_pairs)))] if all_pairs else []
            state["nextPair"] = (offset + len(selected)) % len(all_pairs) if all_pairs else 0
            for room, identity in selected:
                entry = rooms.get(room)
                baseline = entry is None or entry.get("baseline") is True
                first = entry is None
                if first:
                    entry = {**identity, "cursor": "0", "baseline": True}
                    rooms[room] = entry
                response = transport(config, {"operation": "zzz.changes", "room": room,
                                              "after": entry["cursor"], "limit": 20})
                if not isinstance(response, dict) or response.get("kind") != "zzz.changes" or not isinstance(response.get("items"), list):
                    raise ValueError("changes")
                items = response["items"][:20]
                saw_item = saw_item or bool(items)
                if first and not items and not response.get("nextCursor") and not state.get("pending"):
                    entry["bootstrapAttempted"] = True
                    # The empty first page is a complete baseline. A peer post
                    # arriving after our introduction must be examined normally.
                    entry["baseline"] = False
                    event = {"kind": "bootstrap", "roomId": room, **identity, "at": now}
                    break
                for change in items:
                    if inspected >= 3 or event:
                        break
                    if not isinstance(change, dict) or not isinstance(change.get("cursor"), (str, int)) or not str(change["cursor"]).isdigit():
                        raise ValueError("cursor")
                    entry["cursor"] = str(change["cursor"])
                    if baseline or event or state.get("pending") or change.get("kind") not in ("post.created", "thread.created"):
                        continue
                    post, thread = change.get("postId"), change.get("threadId")
                    if not isinstance(post, str) or not ID.fullmatch(post) or not isinstance(thread, str) or not ID.fullmatch(thread):
                        continue
                    inspected += 1
                    # ZZZ read_thread's after cursor shares the room change
                    # sequence. Read only this new post, even in a long thread.
                    detail = transport(config, {"operation": "zzz.read_thread", "thread": thread,
                                                "after": str(max(0, int(entry["cursor"]) - 1)), "limit": 1})
                    posts = detail.get("posts") if isinstance(detail, dict) else None
                    if not isinstance(posts, list):
                        continue
                    target = next((p for p in posts if isinstance(p, dict) and p.get("id") == post), None)
                    if target is None or target.get("isOwn") is not False or target.get("redacted") is True:
                        continue
                    event = {"kind": "incoming", "roomId": room, **identity, "threadId": thread, "postId": post, "at": now}
                entry["baseline"] = bool(response.get("nextCursor")) if baseline else False
                if event or inspected >= 3:
                    break
            state["rooms"] = rooms
            state["failures"] = 0
            state["retryAt"] = now if saw_item else now + (1200 if pairs else 3600)
            if event:
                # Current authority again immediately before offering an agent turn.
                if current_pairs(transport, config).get(event["roomId"]) == {"requestId": event["requestId"], "consentEpoch": event["consentEpoch"]}:
                    state["pending"] = event
                    keys = ("kind", "roomId") if event["kind"] == "bootstrap" else ("kind", "roomId", "threadId", "postId")
                    return {key: event[key] for key in keys}
            return None
        except Exception:
            state["failures"] = min(int(state.get("failures", 0)) + 1, 8)
            state["retryAt"] = now + min(21600, 60 * 2 ** state["failures"])
            return None


if __name__ == "__main__":
    # The Hermes pre-run script invokes this file. No body or credential is printed.
    import importlib.util
    import sys
    package = "village_bridge"
    spec = importlib.util.spec_from_file_location(package, Path(__file__).with_name("__init__.py"))
    bridge = importlib.util.module_from_spec(spec)
    sys.modules[package] = bridge
    spec.loader.exec_module(bridge)
    home = bridge.hermes_home()
    try:
        config = _plain_json(home / "village-bridge.json", 2048)
        event = poll(home, lambda cfg, payload: bridge.transport(cfg, payload, timeout=10), config, bridge.installed)
    except Exception:
        event = None
    if event:
        print(json.dumps({"event": event}, separators=(",", ":")))
        print('{"wakeAgent":true}')
    else:
        print('{"wakeAgent":false,"reason":"idle"}')
