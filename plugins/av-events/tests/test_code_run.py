"""P10-P1 `code.run@1`: one closed record per `execute_code` call, observe-only, default off."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import sys
from pathlib import Path

import pytest

SESSION = "sess-code"
CONTRACT = json.loads((Path(__file__).parent / "vectors" / "code_run_contract.json").read_text(encoding="utf-8"))

#: A program that would trip several tags, with text that must never leave.
SECRET_CODE = (
    "import subprocess, os\n"
    "secret = open('/root/.hermes/.env').read()  # INDEX_API_KEY lives here\n"
    "print(os.environ.get('OPENROUTER_API_KEY'))\n"
    "subprocess.run(['curl', 'https://protocol.index.network/api/intents'])\n"
    "print('notes-about-alice')\n"
)
SECRET_OUTPUT = "Alice Example lives at 12 Example Road; notes-about-alice"
LEAKS = (
    SECRET_CODE,
    "notes-about-alice",
    "Alice Example",
    "/root/.hermes/.env",
    ".hermes",
    "INDEX_API_KEY",
    "OPENROUTER_API_KEY",
    "index.network",
    "protocol.index.network",
    "curl",
    "subprocess.run",
)


def keyed(text: str) -> str:
    key = (Path(os.environ["HERMES_HOME"]) / "av-events" / "hash.key").read_text(encoding="ascii").strip()
    return hmac.new(bytes.fromhex(key), text.encode("utf-8", errors="surrogatepass"), hashlib.sha256).hexdigest()


def result_json(output: str = SECRET_OUTPUT, *, status: str = "success", tool_calls_made=2, **extra) -> str:
    body = {"status": status, "output": output, "tool_calls_made": tool_calls_made, "duration_seconds": 0.4}
    body.update(extra)
    return json.dumps(body, ensure_ascii=False)


@pytest.fixture()
def live(plugin, ctx, monkeypatch):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id=SESSION, model="m", platform="telegram")
    return plugin


@pytest.fixture()
def on(monkeypatch):
    monkeypatch.setenv("AV_EVENTS_CODE_RUN", "1")


def fire(ctx, tool_name="execute_code", code=SECRET_CODE, result=None, *, status="ok", args=None, **extra):
    ctx.fire(
        "post_tool_call",
        session_id=extra.pop("session_id", SESSION),
        task_id=extra.pop("task_id", "task-9"),
        turn_id=extra.pop("turn_id", "turn-1"),
        tool_name=tool_name,
        args={"code": code} if args is None else args,
        result=result_json() if result is None else result,
        tool_call_id=extra.pop("tool_call_id", "call-1"),
        api_request_id="req-1",
        duration_ms=extra.pop("duration_ms", 400),
        status=status,
        error_type=extra.pop("error_type", None),
        error_message=extra.pop("error_message", None),
        **extra,
    )


def of_type(av, plugin, event_type):
    return [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"] == event_type]


def code_runs(av, plugin):
    return of_type(av, plugin, "code.run")


def cr(plugin):
    return sys.modules[f"{plugin.__name__}._code_run"]


# --------------------------------------------------------------------------
# The switch
# --------------------------------------------------------------------------


@pytest.mark.parametrize("value", [None, "", "0", "false", "off", "no", "maybe", "2", "enabled"])
def test_flag_off_or_malformed_sends_no_code_run_and_builds_nothing(live, ctx, av, monkeypatch, value):
    if value is not None:
        monkeypatch.setenv("AV_EVENTS_CODE_RUN", value)
    module = cr(live)

    def boom(*a, **k):
        raise AssertionError("built with the switch off")

    monkeypatch.setattr(module, "code_run_payload", boom)
    monkeypatch.setattr(module, "gated_hosts", boom)
    fire(ctx)
    assert code_runs(av, live) == []
    assert len(of_type(av, live, "tool.call")) == 1


@pytest.mark.parametrize("value", ["1", "true", "YES", " on "])
def test_flag_on_spellings(live, ctx, av, monkeypatch, value):
    monkeypatch.setenv("AV_EVENTS_CODE_RUN", value)
    fire(ctx)
    assert len(code_runs(av, live)) == 1


def test_flag_is_read_from_dotenv_like_the_other_switches(live, ctx, av, home):
    (home / ".env").write_text("AV_EVENTS_CODE_RUN=1\n", encoding="utf-8")
    fire(ctx)
    assert len(code_runs(av, live)) == 1


# --------------------------------------------------------------------------
# The event
# --------------------------------------------------------------------------


def test_one_code_run_per_execute_code_with_exactly_the_contract_keys(live, ctx, av, on):
    fire(ctx, tool_call_id="call-1")
    fire(ctx, tool_call_id="call-2", code="print(1)")
    fire(ctx, tool_name="terminal", args={"command": "ls"}, result="{}")
    fire(ctx, tool_name="read_file", args={"path": "/x"}, result="{}")
    events = code_runs(av, live)
    assert len(events) == 2
    assert len(of_type(av, live, "tool.call")) == 4
    for event in events:
        assert list(event["payload"]) == list(cr(live).FIELD_NAMES) == list(CONTRACT["fields"])
        assert event["schema_version"] == CONTRACT["version"] == 1
        assert event["actor"] == CONTRACT["actor"]
        assert event["evidence_class"] == CONTRACT["evidence_class"]
    first = events[0]["payload"]
    assert first["consent_scope"] == "all"
    assert first["code_hmac"] == keyed(SECRET_CODE)
    assert first["code_bytes"] == len(SECRET_CODE.encode("utf-8"))
    assert first["status"] == "ok"
    assert first["error_type"] is None
    assert first["tool_calls_made"] == 2
    assert first["unavailable_tool_refusals"] == 0
    assert first["unavailable_tools"] == []
    # A read of the home's .env, not a write: no hermes_home_write.
    assert first["risk_tags"] == ["dotenv_path", "gated_host", "os_environ", "subprocess"]
    assert first["rules_version"] == "code_run_tags_v1"
    assert first["category_version"] == "tool_categories_v3"


def test_no_text_leaks_anywhere_in_the_serialised_event(live, ctx, av, on, monkeypatch):
    monkeypatch.setenv("CONTROL_PLANE_URL", "https://control-plane-production-606c.up.railway.app")
    output = SECRET_OUTPUT + "\n" + "{\"error\": \"Tool 'mcp__secretserver__steal' is not available in execute_code. Available: terminal\"}"
    fire(ctx, result=result_json(output, error="notes-about-alice failed"))
    (event,) = code_runs(av, live)
    text = json.dumps(event, ensure_ascii=False)
    for leak in LEAKS + ("mcp__secretserver__steal", "secretserver", "control-plane-production", "railway.app", output):
        assert leak not in text, leak
    assert event["payload"]["unavailable_tools"] == ["other"]


def test_envelope_carries_only_tool_calls_ids(live, ctx, av, on):
    fire(ctx, tool_call_id="call-7", turn_id="turn-3", task_id="task-4")
    (tool_call,) = of_type(av, live, "tool.call")
    (event,) = code_runs(av, live)
    for key in ("session_id", "turn_id", "run_id", "tool_call_id"):
        assert event[key] == tool_call[key], key
    assert event["tool_call_id"] == "call-7"
    for key in ("intention_id", "opportunity_id", "decision_id", "action_id", "outcome_id", "parent_run_id",
                "in_reply_to_event_id", "supersedes_event_id", "model_id", "prompt_version", "skill_version",
                "policy_version"):
        assert event[key] is None, key
    assert event["event_id"] != tool_call["event_id"]


def test_metadata_capture_drops_the_hash_and_length(live, ctx, av, on, monkeypatch):
    monkeypatch.setenv("AV_CAPTURE", "metadata")
    live._COLLECTOR.reload_config()
    fire(ctx)
    (event,) = code_runs(av, live)
    assert event["payload"]["code_hmac"] is None
    assert event["payload"]["code_bytes"] is None
    assert event["payload"]["risk_tags"]  # the closed codes still go


def test_status_error_type_and_tool_calls_made(live, ctx, av, on):
    fire(ctx, status="error", error_type="RuntimeError", result=result_json(status="error", tool_calls_made=True))
    fire(ctx, status="weird", error_type="not a class name!", result=result_json(tool_calls_made=10001))
    fire(ctx, result="not json at all")
    fire(ctx, result=json.dumps({"status": "success", "output": "x"}))
    first, second, third, fourth = (e["payload"] for e in code_runs(av, live))
    assert (first["status"], first["error_type"], first["tool_calls_made"]) == ("error", "RuntimeError", None)
    assert (second["status"], second["error_type"], second["tool_calls_made"]) == ("other", None, None)
    assert third["tool_calls_made"] is None
    assert fourth["tool_calls_made"] is None


def test_missing_or_non_string_code_still_emits_with_nulls(live, ctx, av, on):
    fire(ctx, args={"command": "ls"})
    fire(ctx, args={"code": 42})
    fire(ctx, args="not a dict")
    for event in code_runs(av, live):
        payload = event["payload"]
        assert (payload["code_hmac"], payload["code_bytes"], payload["risk_tags"]) == (None, None, [])


# --------------------------------------------------------------------------
# Scope
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "value, expected",
    [
        (None, "all"),
        ("", "all"),
        ("all", "all"),
        ("ALL", "all"),
        ("research_consented", "research_consented"),
        (" Research-Consented ", "research_consented"),
        ("research", "all"),
        ("ops", "all"),
        ("0", "all"),
    ],
)
def test_scope_values(live, ctx, av, on, monkeypatch, value, expected):
    if value is not None:
        monkeypatch.setenv("AV_EVENTS_CODE_RUN_SCOPE", value)
    fire(ctx)
    (event,) = code_runs(av, live)
    assert event["payload"]["consent_scope"] == expected


def test_both_scopes_send_the_same_event_but_the_scope(live, ctx, av, on, monkeypatch):
    fire(ctx, tool_call_id="call-a")
    monkeypatch.setenv("AV_EVENTS_CODE_RUN_SCOPE", "research_consented")
    fire(ctx, tool_call_id="call-b")
    a, b = (e["payload"] for e in code_runs(av, live))
    assert (a["consent_scope"], b["consent_scope"]) == ("all", "research_consented")
    assert {k: v for k, v in a.items() if k != "consent_scope"} == {k: v for k, v in b.items() if k != "consent_scope"}


def test_scope_does_not_bypass_the_plugins_own_gates(plugin, ctx, av, monkeypatch):
    """No token (the tenant is not wired) or AV_EVENTS_ENABLED=0: nothing, in either scope."""
    monkeypatch.setenv("AV_EVENTS_CODE_RUN", "1")
    monkeypatch.setenv("AV_EVENTS_CODE_RUN_SCOPE", "all")
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id=SESSION, model="m", platform="telegram")
    fire(ctx)
    assert av.read_buffer(plugin._COLLECTOR) == []
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_EVENTS_ENABLED", "0")
    plugin._COLLECTOR.reload_config()
    fire(ctx)
    assert av.read_buffer(plugin._COLLECTOR) == []


# --------------------------------------------------------------------------
# Risk tags: each fires on a minimal snippet and not on a near miss
# --------------------------------------------------------------------------

TAG_CASES = [
    ("dotenv_path", "open('/root/.hermes/.env').read()", "x = os.environ; self.env = 1; p = '.venv/bin'"),
    ("dotenv_path", "from dotenv import load_dotenv", "def load_dotenv_like(): pass"),
    ("proc_environ", "open('/proc/self/environ','rb').read()", "open('/proc/cpuinfo').read(); print(os.environ)"),
    ("proc_environ", "os.path.join('/proc', pid, 'environ')", "os.path.join('/proc', pid, 'status')"),
    ("proc_environ", "psutil.Process(1).environ()", "environ = {}"),
    ("os_environ", "import os\nprint(os.environ['HOME'])", "environment = 'prod'"),
    ("os_environ", "from os import getenv\ngetenv('X')", "print('getenv is a word')"),
    ("subprocess", "import subprocess\nsubprocess.run(['ls'])", "n_subprocesses = 3"),
    ("subprocess", "os.system('ls')", "my_os.systematic = 1"),
    ("socket_or_http_client", "import urllib.request\nurllib.request.urlopen(u)", "print('socket')"),
    ("socket_or_http_client", "import os, socket", "import os, json"),
    ("socket_or_http_client", "requests.post(u, json=d)", "my_requests.append(1)"),
    ("hermes_home_write", "open(os.path.join(os.environ['HERMES_HOME'], 'notes.txt'), 'w').write('y')",
     "open(os.path.join(os.environ['HERMES_HOME'], 'notes.txt')).read()"),
    ("hermes_home_write", "Path('~/.hermes/config.yaml').expanduser().write_text(y)", "Path('/tmp/a').write_text(y)"),
    ("scripts_dir_write", "open('/root/.hermes/scripts/tick.py', 'w').write(s)", "print(open('skills/x/scripts/a.py').read())"),
    ("cron_write", "json.dump(jobs, open(home + '/cron/jobs.json', 'w'))", "print(open(home + '/cron/jobs.json').read())"),
    ("gated_host", "urlopen('https://protocol.index.network/api/intents')", "urlopen('https://myindex.network/')"),
    ("gated_host", "u = 'https://api.telegram.org/bot' + t", "u = 'https://telegram.org.example/'"),
    ("gated_host", "u = 'https://openrouter.ai/api/v1/chat'", "u = 'https://notopenrouter.ai/'"),
    ("gated_host", "u = 'https://api.edgeos.world/api/v1/humans/me'", "u = 'https://edgeos.worldwide.example/'"),
    ("gated_host", "u = 'https://control-plane-production-606c.up.railway.app/x'", "u = 'https://other.up.railway.app/x'"),
    ("base64_or_eval", "import base64\nbase64.b64decode(s)", "ast.literal_eval(s); evaluate(s); re.compile(p)"),
    ("base64_or_eval", "exec(payload)", "self.exec_count = 1; obj.exec(x)"),
]


@pytest.mark.parametrize("tag, hit, miss", TAG_CASES)
def test_each_risk_tag_fires_and_its_near_miss_does_not(plugin, tag, hit, miss):
    module = cr(plugin)
    hosts = module.gated_hosts()
    assert tag in module.risk_tags(hit, hosts), (tag, hit)
    assert tag not in module.risk_tags(miss, hosts), (tag, miss)


def test_every_tag_has_a_case_and_the_set_is_closed(plugin):
    module = cr(plugin)
    assert {case[0] for case in TAG_CASES} == set(module.RISK_TAGS)
    assert sorted(module.RISK_TAGS) == CONTRACT["fields"]["risk_tags"]["enum"]
    everything = "\n".join(case[1] for case in TAG_CASES)
    tags = module.risk_tags(everything, module.gated_hosts())
    assert tags == sorted(module.RISK_TAGS)
    assert module.risk_tags("", ()) == []
    assert module.risk_tags("print('hello')", module.gated_hosts()) == []


def test_gated_host_reads_the_hosts_the_plugin_already_holds(plugin, monkeypatch):
    module = cr(plugin)
    code = "urlopen('https://index.dev.example.org/api')"
    assert "gated_host" not in module.risk_tags(code, module.gated_hosts())
    monkeypatch.setenv("INDEX_API_URL", "https://index.dev.example.org/api")
    assert "gated_host" in module.risk_tags(code, module.gated_hosts())
    monkeypatch.delenv("INDEX_API_URL")
    monkeypatch.setenv("EDGEOS_API_BASE", "https://edgeos.staging.example.net/api/v1")
    assert "gated_host" in module.risk_tags("get('https://edgeos.staging.example.net/x')", module.gated_hosts())
    monkeypatch.setenv("CONTROL_PLANE_URL", "https://cp.staging.example.com")
    assert "gated_host" in module.risk_tags("get('https://CP.staging.example.com/x')", module.gated_hosts())


def test_a_long_program_scans_in_linear_time(plugin):
    module = cr(plugin)
    hosts = module.gated_hosts()
    code = ("open(" + "a" * 600 + "\n") * 2000 + "/proc/" * 20000 + "x" * 200000
    import time

    started = time.monotonic()
    module.risk_tags(code, hosts)
    assert time.monotonic() - started < 2.0


# --------------------------------------------------------------------------
# Refusal counting
# --------------------------------------------------------------------------


def refusal(name: str) -> str:
    return f"{{\"error\": \"Tool '{name}' is not available in execute_code. Available: patch, read_file, terminal\"}}"


def test_refusals_are_counted_and_named_only_from_the_allowlist(live, ctx, av, on):
    output = "\n".join([
        refusal("mcp__index__create_intent"),
        refusal("mcp__index__create_intent"),
        refusal("send_message"),
        refusal("mcp__evil__exfil"),
        refusal("totally made up"),
        "Tool 'x' is available in execute_code",  # not a refusal
    ])
    fire(ctx, result=result_json(output))
    (event,) = code_runs(av, live)
    payload = event["payload"]
    assert payload["unavailable_tool_refusals"] == 5
    assert payload["unavailable_tools"] == ["mcp__index__create_intent", "other", "send_message"]


def test_refusals_in_error_and_in_a_non_json_result(plugin):
    module = cr(plugin)
    body = module.code_run_payload({"code": "x"}, json.dumps({"status": "error", "output": refusal("terminal"),
                                                             "error": refusal("send_message")}),
                                   "error", None, "sanitized", lambda t: None, "all")
    assert (body["unavailable_tool_refusals"], body["unavailable_tools"]) == (2, ["send_message", "terminal"])
    raw = module.code_run_payload({"code": "x"}, "plain " + refusal("memory"), "ok", None, "sanitized", lambda t: None, "all")
    assert (raw["unavailable_tool_refusals"], raw["unavailable_tools"]) == (1, ["memory"])
    assert raw["tool_calls_made"] is None


def test_refusal_count_and_names_are_bounded(plugin):
    module = cr(plugin)
    listed = sorted(n for n in module.TOOL_CATEGORIES if "'" not in n)[:40]
    text = "\n".join(refusal(n) for n in listed) + "\n" + refusal("unlisted") * 3 + refusal("terminal") * 20000
    count, names = module.refusals([text])
    assert count == module.MAX_COUNT
    assert len(names) == module.MAX_TOOL_NAMES
    assert "other" in names
    assert names == sorted(names)


# --------------------------------------------------------------------------
# Isolation: a failure in one event never costs the other its event
# --------------------------------------------------------------------------


def test_a_code_run_builder_that_throws_still_lets_tool_call_out(live, ctx, av, on, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("builder broke")

    monkeypatch.setattr(cr(live), "code_run_payload", boom)
    fire(ctx)
    assert len(of_type(av, live, "tool.call")) == 1
    assert code_runs(av, live) == []


@pytest.mark.parametrize("target", ["gated_hosts", "scope", "flag_on"])
def test_any_code_run_step_that_throws_still_lets_tool_call_out(live, ctx, av, on, monkeypatch, target):
    def boom(*a, **k):
        raise ValueError(target)

    monkeypatch.setattr(cr(live), target, boom)
    fire(ctx)
    assert len(of_type(av, live, "tool.call")) == 1
    assert code_runs(av, live) == []


def test_a_tool_call_builder_that_throws_still_lets_code_run_out(live, ctx, av, on, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("tool.call broke")

    monkeypatch.setattr(live, "tool_call_payload", boom)
    fire(ctx)
    assert of_type(av, live, "tool.call") == []
    assert len(code_runs(av, live)) == 1


def test_the_hook_returns_nothing_with_the_switch_on(live, ctx, on):
    """post_tool_call stays a pure observer: no return value Hermes could act on."""
    assert ctx.fire("post_tool_call", session_id=SESSION, tool_name="execute_code", args={"code": SECRET_CODE},
                    result=result_json(), status="ok", duration_ms=1, tool_call_id="c") == []


# --------------------------------------------------------------------------
# pre_tool_call is untouched
# --------------------------------------------------------------------------


def test_pre_tool_call_never_reaches_code_run(live, ctx, av, on, monkeypatch):
    module = cr(live)

    def boom(*a, **k):
        raise AssertionError("pre_tool_call reached _code_run")

    for name in ("flag_on", "scope", "gated_hosts", "code_run_payload", "risk_tags", "refusals"):
        monkeypatch.setattr(module, name, boom)
    before = len(av.read_buffer(live._COLLECTOR))
    results = ctx.fire("pre_tool_call", session_id=SESSION, tool_name="execute_code", args={"code": SECRET_CODE},
                       task_id="t", tool_call_id="c")
    assert results == []
    assert len(av.read_buffer(live._COLLECTOR)) == before
    assert "_code_run" not in live._hook_pre_tool_call.__code__.co_names


# --------------------------------------------------------------------------
# Manifest and contract
# --------------------------------------------------------------------------


def test_manifest_lists_both_variables(plugin):
    import yaml

    manifest = yaml.safe_load((Path(plugin.__file__).parent / "plugin.yaml").read_text(encoding="utf-8"))
    assert {"AV_EVENTS_CODE_RUN", "AV_EVENTS_CODE_RUN_SCOPE"} <= set(manifest["optional_env"])


def test_contract_vector_matches_the_module(plugin):
    module = cr(plugin)
    assert CONTRACT["type"] == module.TYPE
    assert CONTRACT["switch"]["env"] == module.FLAG
    assert CONTRACT["scope_switch"]["env"] == module.SCOPE_ENV
    assert CONTRACT["scope_switch"]["values"] == list(module.SCOPES)
    assert CONTRACT["fields"]["consent_scope"]["enum"] == list(module.SCOPES)
    assert CONTRACT["fields"]["rules_version"]["current"] == module.RULES_VERSION
    assert CONTRACT["fields"]["category_version"]["current"] == module.TOOL_CATEGORY_VERSION
    assert CONTRACT["fields"]["unavailable_tools"]["max_items"] == module.MAX_TOOL_NAMES
    assert CONTRACT["fields"]["tool_calls_made"]["range"][1] == module.MAX_COUNT
    # Version 1: no entry in `_core.SCHEMA_VERSIONS`.
    assert "code.run" not in sys.modules[f"{plugin.__name__}._core"].SCHEMA_VERSIONS
