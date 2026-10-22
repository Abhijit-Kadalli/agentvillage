"""The no_agent responder sends only its fixed instruction and current post."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from contextlib import contextmanager
from unittest.mock import patch


RUNNER = Path(__file__).parents[3] / "skills/zzzbot/scripts/zzz_managed_runner.py"
spec = importlib.util.spec_from_file_location("zzz_managed_runner_test", RUNNER)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class _Client:
    def __init__(self, content="A useful reply.", tool_calls=None):
        self.calls = []
        self.content = content
        self.tool_calls = tool_calls
        self.options = None
        self.chat = types.SimpleNamespace(completions=types.SimpleNamespace(create=self.create))

    def __enter__(self): return self

    def __exit__(self, *_args): pass

    def create(self, **kwargs):
        self.calls.append(kwargs)
        message = types.SimpleNamespace(content=self.content, tool_calls=self.tool_calls, function_call=None)
        return types.SimpleNamespace(choices=[types.SimpleNamespace(message=message, finish_reason="stop")])


class ManagedRunnerTest(unittest.TestCase):
    def provider(self, client):
        class Http:
            def __init__(self, **kwargs): self.options = kwargs
            def __enter__(self): return self
            def __exit__(self, *_args): pass

        openai = types.ModuleType("openai")
        openai.OpenAI = lambda **kwargs: setattr(client, "options", kwargs) or client
        httpx = types.ModuleType("httpx")
        httpx.Client = Http
        return patch.dict(sys.modules, {"openai": openai, "httpx": httpx})

    @staticmethod
    def config(home, provider="openrouter"):
        (home / "config.yaml").write_text(f"model:\n  provider: {provider}\n  default: configured-model\n")

    def test_actual_completion_request_excludes_every_private_context_source(self):
        with tempfile.TemporaryDirectory(dir="/private/tmp") as tmp:
            home = Path(tmp)
            markers = ["MEMORY_PRIVATE", "USER_PRIVATE", "SOUL_PRIVATE", "AGENTS_PRIVATE",
                       "PROFILE_PRIVATE", "PREFILL_PRIVATE", "PLATFORM_PRIVATE", "PLUGIN_PRIVATE"]
            for name, marker in zip(("MEMORY.md", "USER.md", "SOUL.md", "AGENTS.md", "profile.md",
                                     "prefill.json", "platform_hints.txt", "plugins.txt"), markers):
                (home / name).write_text(marker)
            self.config(home)
            client = _Client()
            bridge = types.SimpleNamespace(installed=lambda *_args: True, transport=lambda *_args, **_kw: {})
            native = []
            event = {"kind": "incoming", "roomId": "room_a", "threadId": "thread_a", "postId": "post_b"}

            class Managed:
                @staticmethod
                def participation_on(_home): return True

                @staticmethod
                def poll(*_args): return event

                @staticmethod
                @contextmanager
                def managed_runner_scope(_job, _session):
                    yield

            with (self.provider(client), patch.dict("os.environ", {"OPENROUTER_API_KEY": "test-key"}),
                  patch.object(runner, "_bridge", return_value=(bridge, Managed)),
                  patch.object(runner, "_job", return_value="abcdef123456"),
                  patch.object(runner, "_config", return_value={}),
                  patch.object(runner, "_pending_post", return_value="Can we meet at three?"),
                  patch.object(runner, "_native", side_effect=lambda *args: native.append(args[-1]) or {})):
                runner.run(home)
            self.assertEqual(native, [{"operation": "zzz.reply", "thread": "thread_a", "body": "A useful reply."}])
            self.assertEqual(len(client.calls), 1)
            self.assertEqual(client.options["base_url"], "https://openrouter.ai/api/v1")
            self.assertEqual(client.options["max_retries"], 0)
            self.assertFalse(client.options["http_client"].options["trust_env"])
            request = client.calls[0]
            self.assertEqual(set(request), {"model", "messages", "max_tokens", "timeout"})
            self.assertEqual(request["max_tokens"], 512)
            self.assertEqual(request["timeout"], 30)
            self.assertEqual(request["messages"], [
                {"role": "system", "content": runner.SYSTEM},
                {"role": "user", "content": "Can we meet at three?"},
            ])
            self.assertTrue(all(marker not in json.dumps(request) for marker in markers))

    def test_tool_call_and_unbounded_completion_cannot_become_native_reply(self):
        with tempfile.TemporaryDirectory(dir="/private/tmp") as tmp:
            home = Path(tmp)
            self.config(home)
            for client in (_Client("reply", tool_calls=[{"name": "village"}]), _Client("x" * 8001), _Client("")):
                with self.provider(client), patch.dict("os.environ", {"OPENROUTER_API_KEY": "test-key"}), self.assertRaises(ValueError):
                    runner._reply("one current post", home)
                self.assertEqual(len(client.calls), 1)

    def test_external_agent_provider_is_rejected_before_client_construction(self):
        with tempfile.TemporaryDirectory(dir="/private/tmp") as tmp:
            home = Path(tmp)
            self.config(home, "copilot-acp")
            client = _Client()
            with self.provider(client), self.assertRaises(ValueError):
                runner._reply("one current post", home)
            self.assertIsNone(client.options)

    def test_provider_key_is_bound_to_this_home(self):
        with tempfile.TemporaryDirectory(dir="/private/tmp") as tmp:
            home = Path(tmp)
            self.config(home)
            (home / ".env").write_text("OPENROUTER_API_KEY=profile-key\n")
            with patch.dict("os.environ", {"OPENROUTER_API_KEY": "other-profile-key"}):
                endpoint, key, model = runner._model_route(home)
            self.assertEqual((endpoint, key, model),
                ("https://openrouter.ai/api/v1", "profile-key", "configured-model"))

    def test_control_plane_model_without_provider_uses_only_bound_openrouter_route(self):
        with tempfile.TemporaryDirectory(dir="/private/tmp") as tmp:
            home = Path(tmp)
            (home / ".env").write_text("OPENROUTER_API_KEY=profile-key\n")
            for provider_line in ("", "  provider: auto\n"):
                (home / "config.yaml").write_text(
                    "model:\n  default: openai/gpt-6-luna\n  max_tokens: 4096\n" + provider_line)
                with patch.dict("os.environ", {"OPENROUTER_API_KEY": "other-profile-key"}):
                    self.assertEqual(runner._model_route(home),
                        ("https://openrouter.ai/api/v1", "profile-key", "openai/gpt-6-luna"))
            (home / ".env").unlink()
            with patch.dict("os.environ", {"OPENROUTER_API_KEY": "other-profile-key"}), self.assertRaises(ValueError):
                runner._model_route(home)

    def test_bootstrap_supplies_the_real_bridge_required_fields(self):
        bridge_spec = importlib.util.spec_from_file_location("village_bridge", Path(__file__).parents[1] / "__init__.py")
        bridge = importlib.util.module_from_spec(bridge_spec)
        with patch.dict(sys.modules, {"village_bridge": bridge}):
            bridge_spec.loader.exec_module(bridge)
        managed = sys.modules["village_bridge._zzz_managed"]
        calls = []
        fake_bridge = types.SimpleNamespace(installed=lambda *_args: True, transport=lambda *_args, **_kw: {})

        class Managed:
            INTRO_TITLE, INTRO_BODY = managed.INTRO_TITLE, managed.INTRO_BODY

            @staticmethod
            def participation_on(_home): return True

            @staticmethod
            def poll(*_args): return {"kind": "bootstrap", "roomId": "room_a"}

            @staticmethod
            @contextmanager
            def managed_runner_scope(_job, _session): yield

        with (patch.object(runner, "_bridge", return_value=(fake_bridge, Managed)),
              patch.object(runner, "_job", return_value="abcdef123456"),
              patch.object(runner, "_config", return_value={}),
              patch.object(runner, "_native", side_effect=lambda *args: calls.append(args[-1]) or {})):
            runner.run(Path("/private/tmp"))
        self.assertEqual(len(calls), 1)
        args = {"operation": calls[0]["operation"], "arguments": {
            key: value for key, value in calls[0].items() if key != "operation"}}
        payload = bridge.zzz_payload("zzz.create_thread", args, {"SESSION_KEY": "s", "MESSAGE_ID": "m"})
        self.assertEqual(payload["room"], "room_a")
        self.assertEqual(payload["title"], managed.INTRO_TITLE)
        self.assertEqual(payload["body"], managed.INTRO_BODY)

    def test_native_call_uses_reviewed_bridge_argument_envelope(self):
        calls = []
        bridge = types.SimpleNamespace(handle=lambda args, **kwargs:
            calls.append((args, kwargs)) or json.dumps({"data": {"kind": "zzz.thread", "posts": []}}))
        result = runner._native(bridge, "cron_abcdef123456_20261023_120000", "cron:abcdef123456:0123456789abcdef",
                                {"operation": "zzz.read_thread", "thread": "thread_a", "after": "7", "limit": 1})
        self.assertEqual(result, {"kind": "zzz.thread", "posts": []})
        self.assertEqual(calls[0][0], {"operation": "zzz.read_thread", "arguments":
            {"thread": "thread_a", "after": "7", "limit": 1}})

    def test_runner_failure_exposes_only_nonzero_status(self):
        with patch.object(runner, "run", side_effect=ValueError("private-pair-body")), \
             patch.object(runner.os, "_exit", side_effect=SystemExit(1)) as stop:
            try:
                with self.assertRaises(SystemExit):
                    runner.main()
            finally:
                runner.signal.alarm(0)
        stop.assert_called_once_with(1)


if __name__ == "__main__":
    unittest.main()
