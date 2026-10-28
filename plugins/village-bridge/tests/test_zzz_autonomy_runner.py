"""Synthetic, no-network contract tests for the installer-owned event turn."""
import importlib.util
import json
import logging
import os
import sys
import tempfile
import threading
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
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name).resolve()  # macOS /var is a symlink; the runner refuses linked parents
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
                patch.object(runner, "_model_route", return_value=("https://openrouter.ai/api/v1", "fixture", "model")), \
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
                patch.object(runner, "_model_route", return_value=("https://openrouter.ai/api/v1", "fixture", "model")), \
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
            # N1: a non-boolean silent is not silence (1 == True in Python); it is refused, never forwarded.
            Choice.message = SimpleNamespace(content='{"silent":1}', tool_calls=None, function_call=None)
            with self.assertRaisesRegex(ValueError, "model-output"):
                runner._output(context, self.home)
            # S2: a fenced JSON answer and a "length" stop are accepted when the JSON itself is complete.
            Choice.message = SimpleNamespace(content='```json\n{"body":"Fenced answer."}\n```', tool_calls=None, function_call=None)
            self.assertEqual(runner._output(context, self.home), {"body": "Fenced answer."})
            Choice.finish_reason = "length"
            Choice.message = SimpleNamespace(content='{"silent":true}', tool_calls=None, function_call=None)
            self.assertEqual(runner._output(context, self.home), {"silent": True})
            Choice.message = SimpleNamespace(content='{"body":"cut sho', tool_calls=None, function_call=None)
            with self.assertRaises(ValueError):
                runner._output(context, self.home)
            Choice.finish_reason = "content_filter"
            Choice.message = SimpleNamespace(content='{"silent":true}', tool_calls=None, function_call=None)
            with self.assertRaisesRegex(ValueError, "model-response"):
                runner._output(context, self.home)
            Choice.finish_reason = "stop"
            # N2: OpenAI-direct takes max_completion_tokens; OpenRouter takes max_tokens. Both cap at 700.
            self.assertEqual(calls[0].get("max_completion_tokens"), 700)
            self.assertNotIn("max_tokens", calls[0])
        with patch.dict(sys.modules, {"httpx": SimpleNamespace(Client=lambda **_: FakeHttp()),
                                      "openai": SimpleNamespace(OpenAI=OpenAI)}), \
                patch.object(runner, "_model_route", return_value=("https://openrouter.ai/api/v1", "fixture", "model")):
            runner._output(context, self.home)
            self.assertEqual(calls[-1].get("max_tokens"), 700)
            self.assertNotIn("max_completion_tokens", calls[-1])

    def test_unusable_model_route_never_claims(self):
        ops = []
        with patch.dict(sys.modules, {"httpx": SimpleNamespace(Client=lambda **_: FakeHttp())}), \
                patch.object(runner, "_model_route", side_effect=ValueError("model-provider")), \
                patch.object(runner, "_activity", side_effect=lambda *_a, **_k: ops.append("called")):
            with self.assertRaisesRegex(ValueError, "model-provider"):
                runner.run(self.home)
        self.assertEqual(ops, [])

    CANDIDATE = {"id": "12345678-1234-1234-1234-123456789abc", "kind": "comment", "lease_token": "a" * 64}

    def turn(self, ops, fail=False, now=None, candidate=True):
        """One run() with a fake bridge and model; returns normally or raises the turn's failure."""
        def activity(_http, _cfg, operation, **_args):
            ops.append(operation)
            if operation == "claim":
                return {"candidate": dict(self.CANDIDATE) if candidate else None}
            if operation == "context":
                return {"candidate_id": self.CANDIDATE["id"], "kind": "comment", "source": {"body": "A current point."}}
            return {"state": "silent", "post_id": None, "thread_id": None, "replayed": False}
        def output(_context, _home):
            ops.append("model")
            if fail:
                raise ValueError("model-response")
            return {"silent": True}
        with patch.dict(sys.modules, {"httpx": SimpleNamespace(Client=lambda **_: FakeHttp())}), \
                patch.object(runner, "_model_route", return_value=("https://openrouter.ai/api/v1", "k", "m")), \
                patch.object(runner, "_activity", side_effect=activity), \
                patch.object(runner, "_output", side_effect=output), \
                patch.object(runner, "_now", return_value=now if now is not None else runner._now()):
            runner.run(self.home)

    def state(self):
        return json.loads((self.home / "zzzbot" / runner.BACKOFF_FILE).read_text())

    def write_state(self, text):
        (self.home / "zzzbot").mkdir(mode=0o700, exist_ok=True)
        (self.home / "zzzbot" / runner.BACKOFF_FILE).write_text(text)

    def test_consecutive_claimed_failures_back_off_locally_and_success_resets(self):
        ops = []
        now = runner._now()
        # NEW-3: one failure does not back off; the second in a row does, and its first step (10 minutes) is longer
        # than the 5-minute cron interval, so the very next tick is skipped.
        with self.assertRaises(ValueError):
            self.turn(ops, fail=True, now=now)
        self.assertEqual(self.state()["until"], 0)
        with self.assertRaises(ValueError):
            self.turn(ops, fail=True, now=now)
        self.assertEqual(runner.FAILURE_THRESHOLD, 2)
        self.assertEqual(ops.count("model"), 2)
        state = self.state()
        self.assertEqual(state["failures"], 2)
        self.assertEqual(state["until"], now + runner.BACKOFF_BASE_SECONDS)
        self.assertGreater(state["until"], now + 5 * 60)
        # Backing off: the next 5-minute tick makes no claim and no model call.
        before = len(ops)
        self.turn(ops, now=now + 5 * 60)
        self.assertEqual(len(ops), before)
        # Backoff elapsed: the next failure doubles it.
        with self.assertRaises(ValueError):
            self.turn(ops, fail=True, now=now + 600)
        self.assertEqual(self.state()["until"], now + 600 + 2 * runner.BACKOFF_BASE_SECONDS)
        # Every later step stays capped.
        for failures, expected in ((8, runner.BACKOFF_MAX_SECONDS), (4, 4 * runner.BACKOFF_BASE_SECONDS)):
            self.write_state(json.dumps({**self.state(), "failures": failures - 1, "until": 0}))
            with self.assertRaises(ValueError):
                self.turn(ops, fail=True, now=now + 900)
            self.assertEqual(self.state()["until"], now + 900 + min(expected, runner.BACKOFF_MAX_SECONDS))
        # A success clears the failure count (the daily turn count stays).
        self.write_state(json.dumps({**self.state(), "until": 0}))
        self.turn(ops, now=now + 1000)
        self.assertEqual(ops[-4:], ["claim", "context", "model", "complete"])
        self.assertEqual(self.state()["failures"], 0)
        self.assertEqual(self.state()["until"], 0)
        self.assertEqual(self.state()["turns"], ops.count("model"))

    def test_out_of_range_backoff_state_neither_disables_the_guard_nor_hangs(self):
        now = runner._now()
        ops = []
        # NEW-2: a negative count, Infinity, NaN or a far-future "until" read as no backoff now, and the next failure
        # backs off (the guard is never disabled; an unreadable "until" never silently turns autonomy off).
        for text in ('{"failures": -50, "until": 0}', '{"failures": 0, "until": Infinity}',
                     '{"failures": 0, "until": NaN}', '{"failures": 0, "until": 1e300}',
                     '{"failures": true, "until": 0}', '{"failures": 0, "until": -Infinity}',
                     '{"failures": 0, "until": 1%s}' % ("0" * 150)):
            self.write_state(text.replace("}", ', "day": "%s", "turns": 0}' % runner._utc_day(now)))
            before = ops.count("claim")
            with self.assertRaises(ValueError):
                self.turn(ops, fail=True, now=now)
            self.assertEqual(ops.count("claim"), before + 1, text)
            state = self.state()
            self.assertGreaterEqual(state["failures"], runner.FAILURE_THRESHOLD, text)
            self.assertGreater(state["until"], now, text)
            self.assertLessEqual(state["until"], now + runner.BACKOFF_MAX_SECONDS, text)
        # A huge count (fits the 256-byte file) cannot build an unbounded power: the exponent is clamped to 7, the
        # wait to 6 hours, and the stored count stays bounded.
        huge = 10 ** 180
        self.write_state(json.dumps({"failures": huge, "until": 0, "day": runner._utc_day(now), "turns": 0}))
        self.assertLessEqual(len((self.home / "zzzbot" / runner.BACKOFF_FILE).read_bytes()), runner.STATE_MAX_BYTES)
        with self.assertRaises(ValueError):
            self.turn(ops, fail=True, now=now)
        state = self.state()
        self.assertEqual(state["until"], now + runner.BACKOFF_MAX_SECONDS)
        self.assertEqual(state["failures"], runner.FAILURE_COUNT_MAX)
        self.assertEqual(runner.BACKOFF_MAX_EXPONENT, 7)
        # Direct: the clamp holds for any count.
        runner._record_failure(self.home, now, {"failures": huge, "until": 0, "day": runner._utc_day(now), "turns": 1})
        self.assertEqual(self.state()["until"], now + runner.BACKOFF_MAX_SECONDS)

    def test_failure_record_never_blocks_on_a_fifo_and_refuses_non_regular_state(self):
        # NEW-4: a FIFO at the state file never blocks the writer (with or without a reader) and never claims.
        now = runner._now()
        (self.home / "zzzbot").mkdir(mode=0o700)
        fifo = self.home / "zzzbot" / runner.BACKOFF_FILE
        os.mkfifo(fifo, 0o600)
        state = {"failures": 0, "until": 0, "day": runner._utc_day(now), "turns": 0}
        outcome = {}
        def record():
            try:
                runner._record_failure(self.home, now, dict(state))
            except (OSError, ValueError) as error:
                outcome["error"] = error
        worker = threading.Thread(target=record, daemon=True)
        worker.start()
        worker.join(5)
        self.assertFalse(worker.is_alive(), "blocked on a FIFO")
        self.assertIn("error", outcome)
        reader = os.open(fifo, os.O_RDONLY | os.O_NONBLOCK)
        try:
            with self.assertRaisesRegex(ValueError, "state-file"):
                runner._record_failure(self.home, now, dict(state))
        finally:
            os.close(reader)
        ops = []
        with self.assertRaisesRegex(ValueError, "state-file"):
            self.turn(ops, now=now)
        self.assertEqual(ops, [])
        # A hard link is not the runner's file either: it is refused, and the other name keeps its bytes.
        os.unlink(fifo)
        other = self.home / "other.json"
        other.write_text("resident")
        os.link(other, fifo)
        with self.assertRaisesRegex(ValueError, "state-file"):
            runner._record_failure(self.home, now, dict(state))
        self.assertEqual(other.read_text(), "resident")

    def test_daily_cap_of_48_model_turns_per_utc_day(self):
        # Lead ruling: at most 48 model turns per box per UTC day, silent and failed turns alike.
        self.assertEqual(runner.DAILY_MODEL_TURNS, 48)
        day = datetime(2026, 10, 28, 0, 1, tzinfo=timezone.utc).timestamp()
        ops = []
        for tick in range(runner.DAILY_MODEL_TURNS):
            self.turn(ops, now=day + tick * 300)  # every one a silent success
        self.assertEqual(ops.count("model"), 48)
        self.assertEqual(self.state()["turns"], 48)
        # A null claim is not a model turn; neither does it count.
        # The 49th turn of the day: no claim, no model call, a recorded code.
        before = list(ops)
        self.turn(ops, now=day + 48 * 300)
        self.assertEqual(ops, before)
        self.assertEqual(self.state()["code"], runner.DAILY_CAP_CODE)
        self.turn(ops, now=day + 23 * 3600 + 58 * 60)
        self.assertEqual(ops, before)
        # The next UTC day resets the counter.
        self.turn(ops, now=day + 24 * 3600)
        self.assertEqual(ops.count("model"), 49)
        self.assertEqual(self.state()["turns"], 1)
        self.assertNotIn("code", self.state())
        # Failed turns count too, and a null claim does not.
        self.turn(ops, now=day + 24 * 3600 + 300, candidate=False)
        self.assertEqual(self.state()["turns"], 1)
        with self.assertRaises(ValueError):
            self.turn(ops, fail=True, now=day + 24 * 3600 + 600)
        self.assertEqual(self.state()["turns"], 2)

    def test_unreadable_turn_count_fails_closed_for_today_only(self):
        day = datetime(2026, 10, 28, 12, 0, tzinfo=timezone.utc).timestamp()
        ops = []
        for text in ("{trunc", '{"failures": 0, "until": 0, "day": "2026-10-28", "turns": -1}',
                     '{"failures": 0, "until": 0, "day": "2026-10-28", "turns": 4.5}', '{"failures": 0, "until": 0}'):
            self.write_state(text)
            self.turn(ops, now=day)
            self.assertEqual(ops, [], text)
            self.assertEqual(self.state()["day"], "2026-10-28")
            self.assertEqual(self.state()["code"], runner.DAILY_CAP_CODE)
        self.turn(ops, now=day + 12 * 3600)
        self.assertEqual(ops, ["claim", "context", "model", "complete"])

    def test_only_an_earlier_stored_day_resets_the_turn_count(self):
        # A clock stepped back across midnight leaves a FUTURE day stored: that must not grant a fresh 48.
        day = datetime(2026, 10, 28, 12, 0, tzinfo=timezone.utc).timestamp()
        ops = []
        self.write_state('{"failures": 0, "until": 0, "day": "2026-10-29", "turns": 0}')
        self.turn(ops, now=day)
        self.assertEqual(ops, [])
        self.assertEqual(self.state()["day"], "2026-10-28")
        self.assertEqual(self.state()["turns"], runner.DAILY_MODEL_TURNS)
        self.assertEqual(self.state()["code"], runner.DAILY_CAP_CODE)
        # A stored earlier day is a new UTC day: the count resets and the turn runs.
        self.write_state('{"failures": 0, "until": 0, "day": "2026-10-27", "turns": 48}')
        self.assertEqual(runner._state_read(self.home, day)["turns"], 0)
        self.turn(ops, now=day)
        self.assertEqual(ops, ["claim", "context", "model", "complete"])
        self.assertEqual(self.state()["day"], "2026-10-28")
        self.assertEqual(self.state()["turns"], 1)

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
