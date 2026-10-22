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
        self.chat = types.SimpleNamespace(completions=types.SimpleNamespace(create=self.create))

    def create(self, **kwargs):
        self.calls.append(kwargs)
        message = types.SimpleNamespace(content=self.content, tool_calls=self.tool_calls, function_call=None)
        return types.SimpleNamespace(choices=[types.SimpleNamespace(message=message, finish_reason="stop")])


class ManagedRunnerTest(unittest.TestCase):
    def provider(self, client):
        package = types.ModuleType("agent")
        aux = types.ModuleType("agent.auxiliary_client")
        aux.resolve_provider_client = lambda route: (client, "configured-model") if route == "auto" else None
        package.auxiliary_client = aux
        return patch.dict(sys.modules, {"agent": package, "agent.auxiliary_client": aux})

    def test_actual_completion_request_excludes_every_private_context_source(self):
        with tempfile.TemporaryDirectory(dir="/private/tmp") as tmp:
            home = Path(tmp)
            markers = ["MEMORY_PRIVATE", "USER_PRIVATE", "SOUL_PRIVATE", "AGENTS_PRIVATE",
                       "PROFILE_PRIVATE", "PREFILL_PRIVATE", "PLATFORM_PRIVATE", "PLUGIN_PRIVATE"]
            for name, marker in zip(("MEMORY.md", "USER.md", "SOUL.md", "AGENTS.md", "profile.md",
                                     "prefill.json", "platform_hints.txt", "plugins.txt"), markers):
                (home / name).write_text(marker)
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

            with (self.provider(client), patch.object(runner, "_bridge", return_value=(bridge, Managed)),
                  patch.object(runner, "_job", return_value="abcdef123456"),
                  patch.object(runner, "_config", return_value={}),
                  patch.object(runner, "_pending_post", return_value="Can we meet at three?"),
                  patch.object(runner, "_native", side_effect=lambda *args: native.append(args[-1]) or {})):
                runner.run(home)
            self.assertEqual(native, [{"operation": "zzz.reply", "thread": "thread_a", "body": "A useful reply."}])
            self.assertEqual(len(client.calls), 1)
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
        for client in (_Client("reply", tool_calls=[{"name": "village"}]), _Client("x" * 8001), _Client("")):
            with self.provider(client), self.assertRaises(ValueError):
                runner._reply("one current post")
            self.assertEqual(len(client.calls), 1)


if __name__ == "__main__":
    unittest.main()
