"""Credential custody: keep service keys out of the code the agent runs (approval code-gap lane 2).

The gateway needs its service keys: the Index MCP client and av-events run inside it and read them
from its environment (Hermes loads `$HERMES_HOME/.env` into it at start). The code the agent runs
does not: a `terminal` command, a skill script, a cron script, an `execute_code` program. Hermes
v2026.9.24 (0.21.5) already removes provider and messaging keys from those children (its provider
blocklist, the execute_code substring scrub), but not the overlay's own: measured against the real
builders, INDEX_API_KEY, AV_EVENTS_TOKEN and AV_BACKUP_TOKEN reach every foreground and background
terminal child and the terminal's session snapshot file on disk. With INDEX_API_KEY agent code
could publish to Index around the approval gate.

`install()` removes the names `custody_keys.json` marks `strip` from every agent-run child, by three
levers, each fail-soft and each reported:

1. **provider**: a `TerminalEnvironmentProvider` whose `strip_env_keys` is the list, registered in
   Hermes's terminal environment registry. Hermes strips the union of every provider's keys from
   the background/PTY terminal, cron and user scripts, search workers and every non-terminal spawn
   (`_sanitize_subprocess_env`, `hermes_subprocess_env`). It is never a backend: `is_available()`
   is False and `create_environment()` raises.
2. **foreground**: at 0.21.5 the foreground terminal (`tools.environments.local._make_run_env`,
   which `LocalEnvironment._run_bash` calls for every command and for the session snapshot) passes
   an EMPTY plugin key set, so lever 1 does not reach it. The function is wrapped to drop the same
   names from what it returns.
3. **execute_code**: `tools.code_execution_env._scrub_child_env` drops names by substring but lets a
   name a skill declared (`required_environment_variables`, registered at `skill_view`) back in. It
   is wrapped the same way, so a declaration cannot re-admit a stripped name.

What this does not do, stated plainly: `$HERMES_HOME/.env` stays readable by the agent's user, and
so does `/proc/<gateway pid>/environ` (the control plane puts INDEX_API_KEY in the sandbox's launch
environment). Agent-written code that opens either file still gets the keys; closing that needs a
second unix user for agent-run code (APPROVAL-CUSTODY's proposal). This module closes the
environment routes: `env`, `printenv`, `echo $NAME`, `jq -n env`, `os.environ`, the snapshot file.

Switch: `AV_CUSTODY` (process environment). Unset or `1/true/yes/on`: applied. `0/false/no/off`:
nothing is touched and one line says the keys reach agent-run code. Python 3.11, standard library.
Never raises out of `install()`.
"""

from __future__ import annotations

import functools
import importlib
import json
import logging
import os
from pathlib import Path
from typing import Any, Callable, Mapping, Optional

logger = logging.getLogger("av-approval.custody")

MANIFEST_PATH = Path(__file__).resolve().with_name("custody_keys.json")
SWITCH = "AV_CUSTODY"
PROVIDER_NAME = "av_custody"
WRAPPED_MARK = "_av_custody_wrapped"
DECISIONS = frozenset({"strip", "hermes", "agent_readable", "not_secret"})
_OFF = frozenset({"0", "false", "no", "off"})

#: (surface, module, attribute) for the two wrapped builders.
FOREGROUND = ("foreground", "tools.environments.local", "_make_run_env")
EXECUTE_CODE = ("execute_code", "tools.code_execution_env", "_scrub_child_env")
SURFACES = ("provider", FOREGROUND[0], EXECUTE_CODE[0])

OFF_LINE = ("av-approval: custody off (AV_CUSTODY); INDEX_API_KEY, AV_EVENTS_TOKEN and AV_BACKUP_TOKEN "
            "reach agent-run code")
APPLIED_FMT = "av-approval: custody: {n} names withheld from agent-run code ({covered})"
UNCOVERED_FMT = "av-approval: custody: NOT covered: {missing}; those children still receive the service keys"


def load_manifest(path: Path = MANIFEST_PATH) -> dict:
    """The decisions file. Raises on a missing or malformed file (tests pin it; install() catches)."""
    data = json.loads(path.read_text(encoding="utf-8"))
    names = data.get("names")
    if not isinstance(names, dict) or not names:
        raise ValueError("custody_keys.json: 'names' must be a non-empty object")
    for name, entry in names.items():
        if not isinstance(entry, dict) or entry.get("decision") not in DECISIONS:
            raise ValueError(f"custody_keys.json: {name}: decision must be one of {sorted(DECISIONS)}")
        if not str(entry.get("reason") or "").strip():
            raise ValueError(f"custody_keys.json: {name}: a reason is required")
    return data


def strip_names(manifest: Optional[Mapping[str, Any]] = None) -> frozenset[str]:
    """The names marked `strip`."""
    data = manifest if manifest is not None else load_manifest()
    return frozenset(n for n, e in data["names"].items() if e["decision"] == "strip")


def switch(environ: Optional[Mapping[str, str]] = None) -> str:
    """`on` unless AV_CUSTODY is explicitly off."""
    value = (environ if environ is not None else os.environ).get(SWITCH)
    return "off" if value is not None and value.strip().lower() in _OFF else "on"


def scrub(env: Any, names: frozenset[str]) -> Any:
    """`env` without `names`, matched case-folded as Hermes matches them (Windows env blocks are
    case-insensitive). Anything that is not a dict passes through untouched."""
    if not isinstance(env, dict):
        return env
    folded = {n.upper() for n in names}
    return {k: v for k, v in env.items() if not (isinstance(k, str) and k.upper() in folded)}


def wrap(module: Any, attr: str, names: frozenset[str]) -> bool:
    """Wrap `module.attr` (a function returning an env dict) so its result never carries `names`.
    Idempotent. False when the attribute is missing or not callable."""
    original = getattr(module, attr, None)
    if not callable(original):
        return False
    if getattr(original, WRAPPED_MARK, False):
        return True

    @functools.wraps(original)
    def wrapped(*args: Any, **kwargs: Any) -> Any:
        return scrub(original(*args, **kwargs), names)

    setattr(wrapped, WRAPPED_MARK, True)
    setattr(module, attr, wrapped)
    return True


def make_provider(names: frozenset[str], base: type) -> Any:
    """A `TerminalEnvironmentProvider` that only declares `strip_env_keys`; never a backend."""

    class CustodyProvider(base):  # type: ignore[misc, valid-type]
        is_remote = False
        is_container = False

        @property
        def name(self) -> str:
            return PROVIDER_NAME

        @property
        def display_name(self) -> str:
            return "Agent Village credential custody (not a terminal backend)"

        @property
        def strip_env_keys(self) -> frozenset:
            return names

        def is_available(self) -> bool:
            return False

        def probe(self):
            return ("unavailable", "not a terminal backend: av-approval registers it only to strip keys")

        def create_environment(self, **kwargs: Any) -> Any:
            raise RuntimeError("av_custody is not a terminal backend")

    return CustodyProvider()


def _register_provider(names: frozenset[str], importer: Callable[[str], Any]) -> bool:
    registry = importer("agent.terminal_env_registry")
    base = getattr(importer("agent.terminal_env_provider"), "TerminalEnvironmentProvider")
    register = getattr(registry, "register_provider", None)
    if not callable(register):
        return False
    register(make_provider(names, base))
    keys = getattr(registry, "plugin_strip_env_keys", None)
    return callable(keys) and names <= set(keys())


def install(*, importer: Callable[[str], Any] = importlib.import_module,
            environ: Optional[Mapping[str, str]] = None) -> dict[str, bool]:
    """Apply custody; returns which surfaces are covered. Logs one line (two when one is not)."""
    covered = {surface: False for surface in SURFACES}
    try:
        if switch(environ) == "off":
            logger.warning(OFF_LINE)
            return covered
        names = strip_names()
        try:
            covered["provider"] = _register_provider(names, importer)
        except Exception:  # noqa: BLE001 - one lever failing must not stop the others
            covered["provider"] = False
        for surface, module_name, attr in (FOREGROUND, EXECUTE_CODE):
            try:
                covered[surface] = wrap(importer(module_name), attr, names)
            except Exception:  # noqa: BLE001
                covered[surface] = False
        done = [s for s in SURFACES if covered[s]]
        missing = [s for s in SURFACES if not covered[s]]
        logger.info(APPLIED_FMT.format(n=len(names), covered=", ".join(done) or "none"))
        if missing:
            logger.warning(UNCOVERED_FMT.format(missing=", ".join(missing)))
    except Exception:  # noqa: BLE001 - custody must never break Hermes's plugin loading
        try:
            logger.warning(UNCOVERED_FMT.format(missing=", ".join(SURFACES)))
        except Exception:  # noqa: BLE001
            pass
    return covered


__all__ = [
    "DECISIONS",
    "MANIFEST_PATH",
    "OFF_LINE",
    "PROVIDER_NAME",
    "SURFACES",
    "SWITCH",
    "install",
    "load_manifest",
    "make_provider",
    "scrub",
    "strip_names",
    "switch",
    "wrap",
]
