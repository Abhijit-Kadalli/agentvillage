"""Credential custody (`_custody.py`, approval code-gap lane 2): the strip list, the three levers, the inventory.

Fake Hermes modules stand in for the real ones; the Hermes-backed test at the end runs the real builders
when Hermes is importable (it skips in CI, as the other Hermes-backed suites do). Every value here is the
placeholder `example-not-a-key`.
"""

from __future__ import annotations

import abc
import json
import logging
import re
import types
from pathlib import Path

import pytest

from .conftest import PLUGIN_DIR, ExplodingCtx, load_plugin

REPO = PLUGIN_DIR.parents[1]
PH = "example-not-a-key"
STRIP = {"INDEX_API_KEY", "AV_EVENTS_TOKEN", "AV_BACKUP_TOKEN", "ADMIN_TOKEN", "TURING_FALLS_CLAIM_TOKEN"}


def custody():
    plugin = load_plugin()
    return __import__(f"{plugin.__name__}._custody", fromlist=["_custody"])


# ---------------------------------------------------------------------------
# Fake Hermes: the registry, the provider base, the two builders
# ---------------------------------------------------------------------------

class FakeProviderBase(abc.ABC):
    @property
    @abc.abstractmethod
    def name(self) -> str: ...

    @property
    def strip_env_keys(self) -> frozenset:
        return frozenset()

    @abc.abstractmethod
    def is_available(self) -> bool: ...

    @abc.abstractmethod
    def create_environment(self, **kwargs): ...


def fake_hermes(*, registry=True, local=True, code=True):
    providers: list = []
    modules: dict[str, types.ModuleType] = {}
    reg = types.ModuleType("agent.terminal_env_registry")
    if registry:
        reg.register_provider = lambda p: providers.append(p)
        reg.plugin_strip_env_keys = lambda: frozenset().union(*(p.strip_env_keys for p in providers))
    modules["agent.terminal_env_registry"] = reg
    base = types.ModuleType("agent.terminal_env_provider")
    base.TerminalEnvironmentProvider = FakeProviderBase
    modules["agent.terminal_env_provider"] = base
    loc = types.ModuleType("tools.environments.local")
    if local:
        loc._make_run_env = lambda env: {**SOURCE, **env}
    modules["tools.environments.local"] = loc
    ce = types.ModuleType("tools.code_execution_env")
    if code:
        ce._scrub_child_env = lambda source_env, is_passthrough=None, is_windows=None: dict(source_env)
    modules["tools.code_execution_env"] = ce

    def importer(name: str):
        if name not in modules:
            raise ImportError(name)
        return modules[name]

    return importer, modules, providers


SOURCE = {"PATH": "/usr/bin", "INDEX_API_KEY": PH, "index_api_key": PH, "AV_EVENTS_TOKEN": PH,
          "AV_BACKUP_TOKEN": PH, "EDGEOS_API_KEY": PH, "AV_POPUP_ID": PH, "TELEGRAM_BOT_TOKEN": PH}


# ---------------------------------------------------------------------------
# The decisions file
# ---------------------------------------------------------------------------

def test_the_manifest_loads_and_every_entry_has_a_decision_and_a_reason():
    c = custody()
    data = c.load_manifest()
    assert data["version"] == "av_custody_keys_v1"
    for name, entry in data["names"].items():
        assert re.fullmatch(r"[A-Z][A-Z0-9_]*", name), name
        assert entry["decision"] in c.DECISIONS and entry["reason"].strip(), name


def test_the_strip_list_is_the_one_this_lane_decided():
    assert custody().strip_names() == STRIP


def test_provider_keys_hermes_strips_are_not_on_the_overlay_list():
    # The plugin's keys are Hermes's tier 1: stripped even where a child is meant to inherit LLM
    # credentials (codex, claude CLIs). Provider keys must stay Hermes's own tier 2.
    names = custody().load_manifest()["names"]
    for name in ("OPENROUTER_API_KEY", "GROQ_API_KEY", "TELEGRAM_BOT_TOKEN", "BROWSERBASE_API_KEY"):
        assert names[name]["decision"] == "hermes", name


@pytest.mark.parametrize("bad", [
    {"names": {}},
    {"names": {"X_TOKEN": {"decision": "maybe", "reason": "r"}}},
    {"names": {"X_TOKEN": {"decision": "strip", "reason": " "}}},
])
def test_a_malformed_manifest_is_refused(tmp_path, bad):
    path = tmp_path / "custody_keys.json"
    path.write_text(json.dumps(bad), encoding="utf-8")
    with pytest.raises(ValueError):
        custody().load_manifest(path)


# ---------------------------------------------------------------------------
# The levers
# ---------------------------------------------------------------------------

def test_install_covers_all_three_surfaces_and_strips_case_folded(monkeypatch):
    monkeypatch.delenv("AV_CUSTODY", raising=False)
    c = custody()
    importer, modules, providers = fake_hermes()
    covered = c.install(importer=importer)
    assert covered == {"provider": True, "foreground": True, "execute_code": True}

    fg = modules["tools.environments.local"]._make_run_env({"AV_BACKUP_TOKEN": PH, "EXTRA": "1"})
    assert not {k.upper() for k in fg} & STRIP
    assert fg["EDGEOS_API_KEY"] == PH and fg["AV_POPUP_ID"] == PH and fg["EXTRA"] == "1"

    ec = modules["tools.code_execution_env"]._scrub_child_env(SOURCE, is_passthrough=lambda _n: True)
    assert not {k.upper() for k in ec} & STRIP
    assert ec["EDGEOS_API_KEY"] == PH

    assert len(providers) == 1
    provider = providers[0]
    assert provider.name == c.PROVIDER_NAME and provider.strip_env_keys == STRIP
    assert provider.is_available() is False
    with pytest.raises(RuntimeError):
        provider.create_environment(cwd="/", timeout=1)


def test_install_is_idempotent(monkeypatch):
    monkeypatch.delenv("AV_CUSTODY", raising=False)
    c = custody()
    importer, modules, _ = fake_hermes()
    c.install(importer=importer)
    first = modules["tools.environments.local"]._make_run_env
    c.install(importer=importer)
    assert modules["tools.environments.local"]._make_run_env is first
    assert getattr(first, c.WRAPPED_MARK) is True


def test_wrapped_builders_keep_their_arguments_and_pass_non_dicts_through():
    c = custody()
    mod = types.ModuleType("m")
    seen = []
    mod.build = lambda *a, **k: (seen.append((a, k)), None)[1]
    assert c.wrap(mod, "build", frozenset(STRIP))
    assert mod.build(1, x=2) is None and seen == [((1,), {"x": 2})]
    assert c.wrap(mod, "missing", frozenset(STRIP)) is False


@pytest.mark.parametrize("value", ["0", "false", "No", " off "])
def test_the_switch_off_touches_nothing_and_says_so(monkeypatch, caplog, value):
    monkeypatch.setenv("AV_CUSTODY", value)
    c = custody()
    importer, modules, providers = fake_hermes()
    original = modules["tools.environments.local"]._make_run_env
    with caplog.at_level(logging.INFO, logger="av-approval.custody"):
        covered = c.install(importer=importer)
    assert covered == {"provider": False, "foreground": False, "execute_code": False}
    assert modules["tools.environments.local"]._make_run_env is original and providers == []
    assert c.OFF_LINE in [r.getMessage() for r in caplog.records]


@pytest.mark.parametrize("value", [None, "", "1", "on", "yes"])
def test_the_switch_defaults_on(value):
    env = {} if value is None else {"AV_CUSTODY": value}
    assert custody().switch(env) == "on"


def test_a_missing_lever_is_reported_and_the_others_still_apply(monkeypatch, caplog):
    monkeypatch.delenv("AV_CUSTODY", raising=False)
    c = custody()
    importer, modules, providers = fake_hermes(local=False)
    with caplog.at_level(logging.INFO, logger="av-approval.custody"):
        covered = c.install(importer=importer)
    assert covered == {"provider": True, "foreground": False, "execute_code": True}
    lines = [r.getMessage() for r in caplog.records if r.levelno >= logging.WARNING]
    assert lines == ["av-approval: custody: NOT covered: foreground; those children still receive the service keys"]


def test_without_hermes_nothing_raises_and_everything_is_uncovered(monkeypatch):
    monkeypatch.delenv("AV_CUSTODY", raising=False)

    def importer(name):
        raise ImportError(name)

    assert custody().install(importer=importer) == {"provider": False, "foreground": False, "execute_code": False}


def test_register_applies_custody_in_every_gate_state_without_touching_ctx(clean_env, tmp_path, monkeypatch):
    # The gate's switch unset, off and on with a broken gate: custody runs after the backstop each time,
    # and never touches ctx (the off/unset contract the backstop suite pins with ExplodingCtx).
    calls = []
    home = tmp_path / ".hermes"
    home.mkdir()
    clean_env.setenv("HERMES_HOME", str(home))
    for state in (None, "0", "1"):
        if state is None:
            clean_env.delenv("AV_APPROVAL_ENABLED", raising=False)
        else:
            clean_env.setenv("AV_APPROVAL_ENABLED", state)
        plugin = load_plugin()
        c = __import__(f"{plugin.__name__}._custody", fromlist=["_custody"])
        monkeypatch.setattr(c, "install", lambda: calls.append(state) or {})
        ctx = ExplodingCtx() if state != "1" else types.SimpleNamespace(register_hook=lambda *a, **k: None)
        plugin.register(ctx)
    assert calls == [None, "0", "1"]


# ---------------------------------------------------------------------------
# The inventory: every credential-shaped name the overlay reads has a decision
# ---------------------------------------------------------------------------

#: The substrings Hermes's execute_code scrub treats as secret (tools/code_execution_env.py).
SECRET_SUBSTRINGS = ("KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL", "PASSWD", "AUTH", "DSN", "WEBHOOK",
                     "CREDS", "BEARER", "APIKEY")
_NAME = r"([A-Z][A-Z0-9_]*[A-Z0-9])"
CODE_READS = [re.compile(p) for p in (
    r"process\.env\." + _NAME,
    r"process\.env\[\s*[\"']" + _NAME + r"[\"']",
    r"\b(?:envOrDotenv|readPersistedEnvVar|persistedEnvVar|upsertEnvVar)\(\s*(?:[A-Za-z_.]+\s*,\s*)?[\"']"
    + _NAME + r"[\"']",
    r"\benv\." + _NAME + r"\b",
    r"os\.environ\.get\(\s*[\"']" + _NAME,
    r"os\.environ\[\s*[\"']" + _NAME,
    r"os\.getenv\(\s*[\"']" + _NAME,
    r"\benv\(\s*[\"']" + _NAME + r"[\"']",
    r"read_dotenv_value\([^,()]+,\s*[\"']" + _NAME + r"[\"']",
)]
TEXT_READS = [re.compile(r"\$\{?" + _NAME), re.compile(r"^\s*-\s*(?:name:\s*)?" + _NAME + r"\s*$", re.M)]
SCANNED = ("install", "plugins", "skills", "scripts", "workspace")
SKIPPED_PARTS = {"tests", "node_modules", "__pycache__", "fixtures"}
#: Names on a village sandbox that no overlay file reads (APPROVAL-DEPLOYED.md section 5; the control
#: plane's tenantEnv and .env writes). They need a decision too.
ON_THE_BOX = ("OPENROUTER_API_KEY", "GROQ_API_KEY", "TELEGRAM_BOT_TOKEN", "INDEX_API_KEY", "EDGEOS_API_KEY",
              "EDGEOS_BEARER_TOKEN", "AV_EVENTS_TOKEN", "AV_BACKUP_TOKEN", "BROWSERBASE_API_KEY",
              "BROWSERBASE_PROJECT_ID", "AV_APPROVAL_TOKEN_FILE", "APPROVAL_HOOK_TOKEN_ENV", "HERMES_MAX_TOKENS")


def credential_shaped(name: str) -> bool:
    return any(s in name for s in SECRET_SUBSTRINGS)


def inventory() -> dict[str, list[str]]:
    found: dict[str, list[str]] = {}
    for top in SCANNED:
        for path in sorted((REPO / top).rglob("*")):
            rel = path.relative_to(REPO)
            if not path.is_file() or SKIPPED_PARTS & set(rel.parts):
                continue
            if path.suffix in (".ts", ".js", ".mjs", ".py"):
                patterns = CODE_READS
            elif path.suffix in (".sh", ".md", ".json", ".yaml", ".yml", ".example"):
                patterns = TEXT_READS
            else:
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue
            for pattern in patterns:
                for match in pattern.finditer(text):
                    if credential_shaped(match.group(1)):
                        line = text.count("\n", 0, match.start()) + 1
                        found.setdefault(match.group(1), []).append(f"{rel}:{line}")
    return found


def test_the_scan_finds_the_known_readers():
    found = inventory()
    assert any(loc.startswith("skills/mcp.json:") for loc in found["INDEX_API_KEY"])
    assert any(loc.startswith("plugins/av-events/_collector.py:") for loc in found["AV_EVENTS_TOKEN"])
    assert any(loc.startswith("install/restore-memory.ts:") for loc in found["AV_BACKUP_TOKEN"])
    assert any(loc.startswith("skills/edgeos/SKILL.md:") for loc in found["EDGEOS_API_KEY"])
    assert any(loc.startswith("skills/agent-plaza/scripts/") for loc in found["TELEGRAM_BOT_TOKEN"])


def test_every_credential_shaped_name_the_overlay_reads_has_a_decision():
    names = custody().load_manifest()["names"]
    found = inventory()
    missing = {n: locs[:3] for n, locs in found.items() if n not in names}
    assert not missing, (
        "credential-shaped names with no custody decision (add each to plugins/av-approval/custody_keys.json "
        f"with strip, hermes, agent_readable or not_secret, and a reason): {missing}")


def test_every_key_on_the_box_has_a_decision():
    names = custody().load_manifest()["names"]
    assert [n for n in ON_THE_BOX if n not in names] == []


def test_no_stale_decisions():
    # A decision for a name nothing reads and no box carries is a leftover; remove it with the reader.
    names = set(custody().load_manifest()["names"])
    assert names - set(inventory()) - set(ON_THE_BOX) == set()


# ---------------------------------------------------------------------------
# The skills: no literal key pasted into a command
# ---------------------------------------------------------------------------

def skill_files():
    """What the agent reads: every SKILL.md (operator setup docs keep their <YOUR_KEY> placeholders)."""
    return sorted(p for p in (REPO / "skills").rglob("SKILL.md") if "tests" not in p.parts)


def test_no_skill_recipe_asks_for_a_key_to_be_pasted():
    placeholder = re.compile(r"<(?:[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET)[A-Z0-9_]*)>")
    hits = [f"{p.relative_to(REPO)}:{t.count(chr(10), 0, m.start()) + 1}"
            for p in skill_files() for t in [p.read_text(encoding="utf-8")] for m in placeholder.finditer(t)]
    assert hits == []


def test_every_authorization_header_in_a_skill_names_a_variable():
    header = re.compile(r"Authorization:\s*Bearer\s+([^\"'\s\\`]+)")
    bad = []
    for path in skill_files():
        text = path.read_text(encoding="utf-8")
        for m in header.finditer(text):
            if not re.fullmatch(r"\$\{?[A-Z][A-Z0-9_]*\}?|<token>", m.group(1)):
                bad.append(f"{path.relative_to(REPO)}:{text.count(chr(10), 0, m.start()) + 1}: {m.group(1)}")
    assert bad == []


def test_no_skill_recipe_names_a_stripped_variable():
    # A recipe that names a stripped variable would run with it empty.
    names = custody().strip_names()
    pattern = re.compile(r"\$\{?(" + "|".join(sorted(names)) + r")\b")
    hits = []
    for path in skill_files():
        text = path.read_text(encoding="utf-8")
        for block in re.findall(r"```(?:bash|sh)\n(.*?)```", text, re.S):
            hits += [f"{path.relative_to(REPO)}: {m.group(1)}" for m in pattern.finditer(block)]
    assert hits == []


# ---------------------------------------------------------------------------
# Hermes-backed: the real builders at the fleet's build (skips without Hermes)
# ---------------------------------------------------------------------------

def test_against_real_hermes(monkeypatch, tmp_path):
    local = pytest.importorskip("tools.environments.local")
    pytest.importorskip("hermes_cli.config")
    from tools import code_execution_env, env_passthrough  # noqa: PLC0415

    home = tmp_path / ".hermes"
    (home / "cache" / "terminal").mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("TERMINAL_TEMP_DIR", str(home / "cache" / "terminal"))
    monkeypatch.delenv("AV_CUSTODY", raising=False)
    watched = sorted(STRIP | {"EDGEOS_API_KEY", "EDGEOS_BEARER_TOKEN", "OPENROUTER_API_KEY", "TELEGRAM_BOT_TOKEN"})
    for name in watched:
        monkeypatch.setenv(name, PH)

    def present(env):
        return {n for n in watched if env.get(n) == PH}

    covered = custody().install()
    assert covered == {"provider": True, "foreground": True, "execute_code": True}

    hermes_strips = {"OPENROUTER_API_KEY", "TELEGRAM_BOT_TOKEN"}
    readable = {"EDGEOS_API_KEY", "EDGEOS_BEARER_TOKEN"}
    assert present(local._make_run_env({})) == readable
    assert present(local._sanitize_subprocess_env(dict(__import__("os").environ))) == readable
    assert present(local.hermes_subprocess_env()) == readable
    env_passthrough.register_env_passthrough(["EDGEOS_API_KEY", "INDEX_API_KEY", "AV_EVENTS_TOKEN"])
    try:
        assert present(code_execution_env._scrub_child_env(dict(__import__("os").environ))) == {"EDGEOS_API_KEY"}
    finally:
        env_passthrough.clear_env_passthrough()
    assert not hermes_strips & present(local._make_run_env({}))

    shell = local.LocalEnvironment(cwd=str(home), timeout=30)
    try:
        out = shell.execute("env").get("output", "")
        names = {line.split("=", 1)[0] for line in out.splitlines() if "=" in line}
        assert not names & STRIP and readable <= names
        snapshot = Path(shell._snapshot_path)
        text = snapshot.read_text(encoding="utf-8") if snapshot.exists() else ""
        assert not [n for n in STRIP if f"{n}=" in text]
    finally:
        shell.cleanup()
