"""SKILL-CHANGE-NOTE: no /new after a mini-app or its SKILL.md changes.

Why. MINIAPP-PICKUP (`_miniapp_epoch.py`) rebuilds an open chat's system prompt at its next turn
after a mini-app is installed, removed or its staged `skills/<app>/SKILL.md` changes, so the agent
sees the new skill. But the chat's own history still holds what the agent said and saw before: an
earlier refusal ("I can't open team rooms"), or a tool result from before the change, and the model
follows its own transcript over the new prompt (Carter's box, 28 Oct, CLAIMS L30662: refused
`zzz.open_team_room` in an old chat, called it at once after /new). Two things are added to that one
rebuild turn, and nothing to any other turn:

1. One note on that turn's user message (Hermes `pre_llm_call` context), naming each app that changed
   since the chat's stamp, in product's words (CLAIMS L30672):

       <app> was updated: <what it can do now>. Anything said earlier in this chat about what <app>
       can't do may be out of date, so check with the tool before answering.

   Several apps: one "was updated" sentence each, then one closing sentence naming them all. The
   note goes in front of nothing and changes no other turn: Hermes persists the turn's context in the
   user row's `api_content` and replays it byte for byte (`agent/turn_context.py:884-922`), so the
   prompt cache breaks only on this turn, which the rebuild already breaks.

   - `<app>`: the SKILL.md front matter `display_name`, else its first `# ` heading, else the app id.
   - `<what it can do now>`: the front matter `update_note` (one line the change carries, set by the
     release with the change), else the first sentence of its `description`. Read from the staged
     `$HERMES_HOME/skills/<skill>/SKILL.md`: no network call. That file is also where a tag roll's
     checkout copy lands (zzzbot's skill always comes from the overlay checkout,
     `install/install_miniapps.ts:646-657`, staged by the roll's own update, cp `tenants.js:1224`), so a
     roll that changes zzzbot's SKILL.md moves its digest and is noticed like a cp delivery.
   - Which apps: those whose per-app digest (the projection entry plus its SKILL.md digests, exactly
     the fingerprint's per-app part) differs from the one recorded for the chat's stamp
     (`_miniapp_epoch.remembered`). No stamp = no app installed then = every app now is new. A stamp
     with no record (stamped before this change shipped) = the apps carrying an `update_note`, else
     every app with a skill. Removed apps and apps without a skill (zzz-bridge) are never named; when
     no named app is left there is no note.
   - Once: the note is staged only by a `miniapps` rebuild, and that rebuild persists the new stamp,
     so the next turn (cached agent, fresh agent, or after a gateway restart) does not rebuild and no
     note is staged again. In-process, a (session, fingerprint) pair is noted at most once.

2. The chat's saved `village` tool is re-saved from the registry (`repin_village`). Hermes keeps a
   continuing chat's tools[] BYTES while its own code sha is unchanged (`tools/mcp_tool_agent.py:151-157`
   `tool_pin_version`, :194-215 `_pinned_def` returns the pinned item verbatim when `same_code`;
   restored for every continuing chat at `agent/conversation_loop.py:744`). An overlay roll never
   changes Hermes's sha, so a chat begun before ov#531 still sends a `village` enum without
   `zzz.open_team_room`. On the rebuild turn the pinned `village` definition is swapped in place (same
   slot, same name set) for the registry's current one and the pin is persisted. Unchanged bytes: no
   swap, no write.

Switch: none of its own. It runs only on a MINIAPP-PICKUP rebuild, so `AV_MINIAPP_REFRESH=0` or
`miniapp_refresh` in `AV_HOOKS_DISABLED` turns it off with the pick-up. Never raises into the turn;
no content is ever logged. Standard library only.
"""

from __future__ import annotations

import importlib
import logging
import re
import threading
import unicodedata
from collections import OrderedDict
from pathlib import Path
from typing import Any, List, Optional, Tuple

from . import _miniapp_epoch
from ._core import hermes_home

logger = logging.getLogger("av-events")

#: Labels the note as not the resident's words (Hermes appends plugin context raw), as DATA-444 does.
LABEL = "[Agent Village note, not from the resident] "
#: Product's words (CLAIMS L30672).
UPDATED = "{app} was updated: {summary}."
CLOSING = ("Anything said earlier in this chat about what {apps} can't do may be out of date, "
           "so check with the tool before answering.")
#: Used only when a skill has neither an `update_note` nor a `description`.
NO_SUMMARY = "check the tool for what it can do now"

MAX_NAME_CHARS = 60
MAX_SUMMARY_CHARS = 240
MAX_SKILL_BYTES = 1 << 20
#: Sessions with a staged note / (session, fingerprint) pairs already noted.
MAX_SESSIONS = 512
VILLAGE = "village"

_LOCK = threading.Lock()
_PENDING: "OrderedDict[str, str]" = OrderedDict()
_NOTED: "OrderedDict[Tuple[str, str], None]" = OrderedDict()
_INTERRUPTS = (KeyboardInterrupt, SystemExit)

_FENCE_END = re.compile(r"\n---[ \t\r]*\n")
_FIELD = re.compile(r"([A-Za-z0-9_-]+):[ \t]*(.*?)[ \t\r]*$")
_HEADING = re.compile(r"^#[ \t]+(.+?)[ \t\r]*$", re.MULTILINE)


# ---- what the SKILL.md says --------------------------------------------------------------------


def front_matter(text: str) -> Tuple[dict, str]:
    """(plain top-level `key: value` fields, body), the block Hermes finds (`agent/skill_utils.py`
    `parse_frontmatter`: BOM stripped, a leading `---`, closed by the next `---` line). Only plain
    one-line values are read: a block scalar, flow value, anchor, alias or tag is left out."""
    text = text[1:] if text.startswith("﻿") else text
    if not text.startswith("---"):
        return {}, text
    end = _FENCE_END.search(text, 3)
    if end is None:
        return {}, text
    fields: dict = {}
    for line in text[3:end.start()].split("\n"):
        found = _FIELD.fullmatch(line)
        if not found:
            continue
        key, value = found.groups()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        elif not value or value[0] in "|>&*!{[\"'":
            continue
        fields.setdefault(key, value)
    return fields, text[end.end():]


def _clean(text: Any, cap: int) -> str:
    """One line: no control or format characters, single spaces, at most `cap` characters (cut at a
    word, with an ellipsis), no closing punctuation (the sentence adds its own full stop)."""
    if not isinstance(text, str):
        return ""
    kept = "".join(" " if unicodedata.category(ch) in ("Cc", "Cf", "Zl", "Zp") else ch for ch in text)
    line = " ".join(kept.split())
    if len(line) > cap:
        line = line[:cap].rsplit(" ", 1)[0].rstrip(" ,;:") + "…"
    return line.rstrip(" .!;:,")


def _first_sentence(text: str) -> str:
    sentence = re.split(r"(?<=[.!?])\s+", text.strip(), maxsplit=1)[0]
    # "Always send ..." reads as "was updated: always send ...", but "UPI ..." keeps its case.
    if len(sentence) > 1 and sentence[0].isupper() and sentence[1].islower():
        sentence = sentence[0].lower() + sentence[1:]
    return sentence


def _skill_text(home: Path, name: str) -> Optional[str]:
    if not _miniapp_epoch.SKILL_NAME.fullmatch(name):
        return None
    path = home / "skills" / name / "SKILL.md"
    try:
        if not _miniapp_epoch._no_symlink_below(home, path):
            return None
        raw = _miniapp_epoch._read_nofollow(path, MAX_SKILL_BYTES)
    except OSError:
        return None
    if raw is None:
        return None
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return None


def app_line(app_id: str, skills: List[str], home: Optional[Path] = None) -> Optional[Tuple[str, str, bool]]:
    """(display name, what it can do now, whether the change carried an `update_note`) from the app's
    first readable SKILL.md; None when it has none."""
    home = Path(home) if home is not None else Path(hermes_home())
    for name in skills:
        text = _skill_text(home, name)
        if text is None:
            continue
        fields, body = front_matter(text)
        heading = _HEADING.search(body)
        display = (_clean(fields.get("display_name"), MAX_NAME_CHARS)
                   or (_clean(heading.group(1), MAX_NAME_CHARS) if heading else "") or app_id)
        note = _clean(fields.get("update_note"), MAX_SUMMARY_CHARS)
        summary = note or _clean(_first_sentence(fields.get("description") or ""), MAX_SUMMARY_CHARS) or NO_SUMMARY
        return display, summary, bool(note)
    return None


def render(lines: List[Tuple[str, str]]) -> str:
    """The note for (display name, summary) pairs, in order."""
    names = [name for name, _ in lines]
    joined = names[0] if len(names) == 1 else ", ".join(names[:-1]) + " or " + names[-1]
    sentences = " ".join(UPDATED.format(app=name, summary=summary) for name, summary in lines)
    return f"{LABEL}{sentences} {CLOSING.format(apps=joined)}"


def note_for(old_stamp: str, home: Optional[Path] = None) -> Optional[Tuple[str, str]]:
    """(fingerprint now, the note) for a chat stamped `old_stamp`; None when no installed app with a
    skill changed since (or the projection cannot be read)."""
    found = _miniapp_epoch.current_apps(home)
    if found is None or not found[0]:
        return None
    current, apps = found
    before = _miniapp_epoch.remembered(old_stamp, home)
    lines = {app_id: app_line(app_id, info["skills"], home) for app_id, info in sorted(apps.items()) if info["skills"]}
    lines = {app_id: line for app_id, line in lines.items() if line is not None}
    if before is None:
        carried = [app_id for app_id, line in lines.items() if line[2]]
        chosen = carried or list(lines)
    else:
        chosen = [app_id for app_id in lines if before.get(app_id) != apps[app_id]["digest"]]
    if not chosen:
        return None
    return current, render([lines[app_id][:2] for app_id in chosen])


# ---- the turn ----------------------------------------------------------------------------------


def _bounded_put(table: "OrderedDict", key: Any, value: Any) -> None:
    table[key] = value
    table.move_to_end(key)
    while len(table) > MAX_SESSIONS:
        table.popitem(last=False)


def stage(session_id: str, old_stamp: str, home: Optional[Path] = None) -> bool:
    """After a `miniapps` rebuild: stage the note for this session's `pre_llm_call` in the same turn.
    True when one was staged. At most once per (session, fingerprint) in this process."""
    if not isinstance(session_id, str) or not session_id:
        return False
    found = note_for(old_stamp or "", home)
    if found is None:
        return False
    current, note = found
    with _LOCK:
        if (session_id, current) in _NOTED:
            return False
        _bounded_put(_NOTED, (session_id, current), None)
        _bounded_put(_PENDING, session_id, note)
    return True


def take(session_id: Any) -> Optional[str]:
    """The staged note for this session, once."""
    if not isinstance(session_id, str) or not session_id:
        return None
    with _LOCK:
        return _PENDING.pop(session_id, None)


def _def_name(tool: Any) -> str:
    function = tool.get("function") if isinstance(tool, dict) else None
    return function.get("name", "") if isinstance(function, dict) else ""


def repin_village(agent: Any) -> bool:
    """Swap the chat's saved `village` definition for the registry's current one, in its slot, and
    persist the pin (Hermes's own `persist_agent_tool_names`). True when the bytes changed. Nothing
    happens when the agent sends no `village` tool, the registry has none (its check failed), or the
    bytes are already current."""
    if not any(_def_name(tool) == VILLAGE for tool in (getattr(agent, "tools", None) or [])):
        return False
    pin = importlib.import_module("tools.mcp_tool_agent")
    registry = importlib.import_module("tools.registry").registry
    lock, persist = pin._agent_tools_lock, pin.persist_agent_tool_names
    fresh = registry.get_definitions({VILLAGE}, quiet=True)
    if len(fresh) != 1 or _def_name(fresh[0]) != VILLAGE:
        return False
    # Hermes's own build sanitizes what the registry gives (`model_tools._compute_tool_definitions`);
    # `village` has no dynamic-schema rewriter. Without the sanitizer, the registry's bytes.
    try:
        fresh = importlib.import_module("tools.schema_sanitizer").sanitize_tool_schemas(fresh)
    except Exception:  # noqa: BLE001
        pass
    with lock:
        tools = list(getattr(agent, "tools", None) or [])
        slots = [i for i, tool in enumerate(tools) if _def_name(tool) == VILLAGE]
        if not slots or tools[slots[0]] == fresh[0]:
            return False
        tools[slots[0]] = fresh[0]
        agent.tools = tools
    persist(agent)
    return True


def after_rebuild(agent: Any, old_prompt: str) -> None:
    """Called by `_prompt_refresh.check_and_refresh` right after a `miniapps` rebuild, in Hermes's
    restore slot (before `pre_llm_call` and before any API call of the turn). Never raises."""
    session_id = getattr(agent, "session_id", None)
    try:
        # The switch as read now (the stamp's own read): a collector's `AV_HOOKS_DISABLED` is re-read only
        # at a session boundary, and an off switch must stop the note at once.
        if not _miniapp_epoch.enabled(None):
            return
    except BaseException as exc:  # noqa: BLE001
        if isinstance(exc, _INTERRUPTS):
            raise
        return
    try:
        if repin_village(agent):
            logger.info("av-events: skill_change_note village tool re-saved")
    except BaseException as exc:  # noqa: BLE001 - the pin stays as it was
        if isinstance(exc, _INTERRUPTS):
            raise
        logger.debug("av-events: skill_change_note village re-save skipped (%s)", type(exc).__name__)
    try:
        stage(session_id, _miniapp_epoch.stamp_in(old_prompt))
    except BaseException as exc:  # noqa: BLE001 - no note
        if isinstance(exc, _INTERRUPTS):
            raise
        logger.debug("av-events: skill_change_note not staged (%s)", type(exc).__name__)


def reset() -> None:
    """Forget staged and given notes (tests; a restart)."""
    with _LOCK:
        _PENDING.clear()
        _NOTED.clear()


__all__ = [
    "CLOSING",
    "LABEL",
    "UPDATED",
    "after_rebuild",
    "app_line",
    "front_matter",
    "note_for",
    "render",
    "repin_village",
    "reset",
    "stage",
    "take",
]
