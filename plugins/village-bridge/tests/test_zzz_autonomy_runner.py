"""Synthetic, no-network contract tests for the installer-owned event turn."""
import importlib.util
import json
import logging
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

SCRIPT = Path(__file__).parents[3] / "skills/zzzbot/scripts/zzz_autonomy_runner.py"
SPEC = importlib.util.spec_from_file_location("zzz_autonomy_runner_test", SCRIPT)
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)
TOKEN = "avb_" + "a" * 43


class FakeHttp:
    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


class TestAutonomyRunner(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir="/private/tmp")
        self.home = Path(self.temp.name)
        (self.home / "cron").mkdir()
        self.cfg = {"origin": "https://agents.edgecity.live", "token": TOKEN,
                    "expiresAt": (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()}
        (self.home / "village-bridge.json").write_text(json.dumps(self.cfg))
        (self.home / "mini-apps.json").write_text(json.dumps({"version": 1, "apps": [
            {"id": "zzzbot", "version": "1.0.0", "operations": ["zzz.list_rooms", "zzz.read_thread", "zzz.changes", "zzz.reply", "zzz.create_thread"], "skills": ["zzzbot"]},
            {"id": "zzz-autonomy-runner", "version": "1.0.0", "operations": [], "skills": []}]}))
        self.job = {"id": "a" * 12, "name": runner.JOB_NAME, "prompt": runner.PROMPT,
                    "script": runner.JOB_SCRIPT, "enabled": True, "no_agent": True,
                    "enabled_toolsets": ["no_mcp"], "workdir": None, "deliver": "local",
                    "failure_deliver": "local", "schedule": {"kind": "cron", "expr": runner.schedule(TOKEN)},
                    "repeat": {"times": None}}
        self.save_job()

    def tearDown(self):
        self.temp.cleanup()

    def save_job(self):
        (self.home / "cron/jobs.json").write_text(json.dumps({"jobs": [self.job]}))

    def test_null_claim_makes_zero_model_calls_and_no_completion(self):
        ops = []
        def activity(_http, _cfg, operation, **_args):
            ops.append(operation)
            return {"candidate": None, "next_check_at": "2026-10-28T00:00:00Z"}
        with patch.dict(sys.modules, {"httpx": SimpleNamespace(Client=lambda **_: FakeHttp())}), \
                patch.object(runner, "_activity", side_effect=activity), \
                patch.object(runner, "_output", side_effect=AssertionError("model called")):
            runner.run(self.home)
        self.assertEqual(ops, ["claim"])

    def test_pause_refusal_after_claim_never_calls_model(self):
        ops = []
        def activity(_http, _cfg, operation, **_args):
            ops.append(operation)
            if operation == "claim":
                return {"candidate": {"id": "12345678-1234-1234-1234-123456789abc", "kind": "comment", "lease_token": "a" * 64}}
            raise ValueError("current policy paused")
        with patch.dict(sys.modules, {"httpx": SimpleNamespace(Client=lambda **_: FakeHttp())}), \
                patch.object(runner, "_activity", side_effect=activity), \
                patch.object(runner, "_output", side_effect=AssertionError("model called")):
            with self.assertRaisesRegex(ValueError, "paused"):
                runner.run(self.home)
        self.assertEqual(ops, ["claim", "context"])

    def test_exact_job_and_projection_are_required(self):
        self.assertEqual(runner._job(self.home, self.cfg), "a" * 12)
        for field, changed in (("no_agent", False), ("enabled_toolsets", ["village"]),
                               ("prompt", "other"), ("schedule", {"kind": "cron", "expr": "* * * * *"})):
            old = self.job[field]
            self.job[field] = changed
            self.save_job()
            with self.assertRaisesRegex(ValueError, "job-shape"):
                runner._job(self.home, self.cfg)
            self.job[field] = old
        self.save_job()
        self.assertTrue(runner._installed(self.home))
        (self.home / "mini-apps.json").write_text(json.dumps({"version": 1, "apps": [
            {"id": "zzzbot", "version": "1.0.0", "operations": ["zzz.list_rooms", "zzz.read_thread", "zzz.changes", "zzz.reply", "zzz.create_thread"], "skills": ["zzzbot"]}]}))
        self.assertFalse(runner._installed(self.home))

    def test_phase_stable_and_silent_output_strict(self):
        self.assertLess(runner.DEADLINE_SECONDS, 90)
        self.assertEqual(runner.schedule(TOKEN), runner.schedule(TOKEN))
        self.assertIn(str(runner.phase(TOKEN)), runner.schedule(TOKEN))
        # No model route is opened on a missing context or malformed source.
        with self.assertRaisesRegex(ValueError, "context-shape"):
            runner._output({"kind": "reply"}, self.home)
        with self.assertRaisesRegex(ValueError, "source-context"):
            runner._output({"kind": "reply", "candidate_id": "x", "source": {"body": "x" * 4001}}, self.home)

    def test_one_isolated_model_call_and_strict_output(self):
        calls = []
        class Choice:
            finish_reason = "stop"
            message = SimpleNamespace(content='{"body":"One focused answer."}', tool_calls=None, function_call=None)
        class Model:
            def create(self, **kwargs):
                calls.append(kwargs)
                return SimpleNamespace(choices=[Choice()])
        class OpenAI:
            def __init__(self, **kwargs):
                self.chat = SimpleNamespace(completions=Model())
            def __enter__(self):
                return self
            def __exit__(self, *_):
                return False
        context = {"kind": "reply", "candidate_id": "x", "source": {"body": "A current point."}}
        with patch.dict(sys.modules, {"httpx": SimpleNamespace(Client=lambda **_: FakeHttp()),
                                      "openai": SimpleNamespace(OpenAI=OpenAI)}), \
                patch.object(runner, "_model_route", return_value=("https://api.openai.com/v1", "fixture", "model")):
            self.assertEqual(runner._output(context, self.home), {"body": "One focused answer."})
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0]["messages"][0]["role"], "system")
            self.assertNotIn("tools", calls[0])
            Choice.message = SimpleNamespace(content='{"body":"x","title":"forbidden"}', tool_calls=None, function_call=None)
            with self.assertRaisesRegex(ValueError, "model-output"):
                runner._output(context, self.home)
            Choice.message = SimpleNamespace(content='{"silent":true}', tool_calls=None, function_call=None)
            self.assertEqual(runner._output(context, self.home), {"silent": True})

    def test_fixed_bridge_route_and_response_size(self):
        calls = []
        class Response:
            status_code = 200
            headers = {}
            data = [b'{"candidate":null}']
            def __enter__(self):
                return self
            def __exit__(self, *_):
                return False
            def iter_bytes(self):
                return iter(self.data)
        class Http:
            def stream(self, method, url, **kwargs):
                calls.append((method, url, kwargs))
                return Response()
        self.assertEqual(runner._activity(Http(), self.cfg, "claim"), {"candidate": None})
        self.assertEqual(calls[0][0:2], ("POST", "https://agents.edgecity.live/api/v1/village-bridge/zzz-autonomy"))
        self.assertFalse(calls[0][2]["follow_redirects"])
        Response.data = [b"x" * 16385]
        with self.assertRaisesRegex(ValueError, "activity-size"):
            runner._activity(Http(), self.cfg, "claim")

    def test_inherited_sdk_debug_cannot_log_room_context(self):
        previous = logging.root.manager.disable
        try:
            with patch.dict(os.environ, {"OPENAI_LOG": "debug"}):
                runner._quiet_sdk()
                self.assertNotIn("OPENAI_LOG", os.environ)
                self.assertGreaterEqual(logging.root.manager.disable, logging.CRITICAL)
        finally:
            logging.disable(previous)


if __name__ == "__main__":
    unittest.main()
