"""av-rate: the suggestion rating cards' buttons, ledger, hand-off records and agent line."""

from __future__ import annotations

import asyncio
import json
import os
import types

import pytest

OWNER = "123456789"
OTHER = "987654321"
TENANT = "0b3c2a1f-aaaa-bbbb-cccc-1234567890ab"
OPP = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d"
OPP2 = "1b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d"
T0 = 1_760_000_000.0

CORE_CALLBACKS = ["ea:once:17", "cl:2:abc", "mp:anthropic", "cp:fast:on", "sc:yes:1", "gt:archive:1", "update_prompt:yes", "avv:0:" + "A" * 44]


# --------------------------------------------------------------------------- fakes


class Button:
    def __init__(self, text, callback_data=None, url=None):
        self.text, self.callback_data, self.url = text, callback_data, url


class Markup:
    def __init__(self, rows):
        self.inline_keyboard = rows


class Sent:
    def __init__(self, message_id):
        self.message_id = message_id


class Bot:
    def __init__(self, fail=0):
        self.sent: list[dict] = []
        self.fail = fail
        self._next = 100

    async def send_message(self, **kwargs):
        if self.fail:
            self.fail -= 1
            raise RuntimeError("telegram down")
        self.sent.append(kwargs)
        self._next += 1
        return Sent(self._next)


class Query:
    def __init__(self, data, bot, user=OWNER, chat=OWNER, rows=None, message_id=101):
        self.data = data
        self.from_user = types.SimpleNamespace(id=int(user))
        self.message = types.SimpleNamespace(chat=types.SimpleNamespace(id=int(chat)), message_id=message_id,
                                             reply_markup=Markup(rows) if rows is not None else None, get_bot=lambda: bot)
        self.answers: list[str] = []
        self.edits: list[object] = []

    async def answer(self, text=None, **_):
        self.answers.append(text)

    async def edit_message_reply_markup(self, reply_markup=None, **_):
        self.edits.append(reply_markup)


class Ctx:
    def __init__(self, accept=True, raises=False):
        self.calls: list[tuple[str, str]] = []
        self.accept, self.raises = accept, raises

    def inject_message(self, content, role="user", *, session_key=None):
        if self.raises:
            raise RuntimeError("no gateway")
        self.calls.append((content, session_key))
        return self.accept


def run(coro):
    return asyncio.run(coro)


def stage(home, plugin, opp=OPP, **over):
    folder = home / "av-events" / "proactive" / "rating"
    folder.mkdir(parents=True, exist_ok=True)
    os.chmod(folder, 0o700)
    data = {"v": 1, "opportunity_id": opp, "intention_id": None, "name": "Maya Rao", "headline": "Climate finance", "agent_name": "Edge",
            "staged_at": plugin.now_iso(T0 - 60), "date": "2026-10-21"}
    data.update(over)
    path = folder / f"stage-{opp}.json"
    path.write_text(json.dumps(data))
    os.chmod(path, 0o600)
    return path


def ledger(home):
    return json.loads((home / "av-events" / "proactive" / "rated.json").read_text())


def records(home):
    folder = home / "av-events" / "proactive" / "rating-events"
    out = []
    for name in sorted(os.listdir(folder)) if folder.exists() else []:
        out += json.loads((folder / name).read_text())["records"]
    return out


@pytest.fixture
def on(monkeypatch):
    monkeypatch.setenv("AV_RATE_CARDS", "1")
    monkeypatch.setenv("TELEGRAM_HOME_CHANNEL", OWNER)
    monkeypatch.setenv("AV_TENANT_ID", TENANT)


def pickup(plugin, bot, ctx=None, now=T0):
    return run(plugin.pick_up(bot, None, lambda t, d: Button(t, callback_data=d), Markup, now=now, ctx=ctx))


def handler(plugin, ctx=None, now=T0):
    return plugin.make_handler(None, make_button=lambda t, d: Button(t, callback_data=d), make_markup=Markup, clock=lambda: now, ctx=ctx)


# --------------------------------------------------------------------------- callback data


def test_callback_data_shape_and_the_64_byte_limit(plugin):
    nonce = plugin.make_nonce(b"k" * 32, OPP)
    assert len(nonce) == 22
    for value in range(1, 6):
        data = plugin.fit_callback(value, nonce)
        assert len(data.encode("utf-8")) <= plugin.CALLBACK_DATA_MAX_BYTES
        assert plugin.parse_callback(data) == ("fit", str(value), nonce)
    assert plugin.parse_callback(plugin.planned_callback("y", nonce)) == ("planned", "y", nonce)
    assert plugin.parse_callback(plugin.planned_callback("n", nonce)) == ("planned", "n", nonce)
    assert len(plugin.planned_callback("n", nonce).encode("utf-8")) <= 64


@pytest.mark.parametrize("data", [None, "", "avr:f:0:" + "a" * 22, "avr:f:6:" + "a" * 22, "avr:p:x:" + "a" * 22, "avr:f:3:" + "a" * 21, "avr:f:3:" + "a" * 23, "avr:f:3:" + "é" * 22, *CORE_CALLBACKS])
def test_parse_refuses_anything_else(plugin, data):
    assert plugin.parse_callback(data) is None


def test_nonce_is_keyed_and_stable(plugin):
    assert plugin.make_nonce(b"k" * 32, OPP) == plugin.make_nonce(b"k" * 32, OPP)
    assert plugin.make_nonce(b"k" * 32, OPP) != plugin.make_nonce(b"j" * 32, OPP)
    assert plugin.make_nonce(b"k" * 32, OPP) != plugin.make_nonce(b"k" * 32, OPP2)


def test_hash_key_prefers_av_events_key_then_makes_its_own(plugin, home):
    own = plugin.hash_key()
    assert own is not None and len(own) == 32
    assert (home / "av-events" / "av-rate.key").exists()
    assert plugin.hash_key() == own
    (home / "av-events" / "hash.key").write_text("ab" * 32 + "\n")
    assert plugin.hash_key() == bytes.fromhex("ab" * 32)


# --------------------------------------------------------------------------- card text and keyboards


def test_card_one_text_labels_privacy_and_manage_line(plugin):
    text = plugin.fit_text("Edge", "Maya <Rao>", "Climate & finance")
    assert text.startswith("How good a match was this suggestion from Edge?\nMaya &lt;Rao&gt;, about Climate &amp; finance\n")
    for value, label in plugin.LABELS.items():
        assert f"{value}  {label}" in text
    assert "Private: only you and the research team see this. Maya &lt;Rao&gt; does not." in text
    assert text.endswith("\n\n" + plugin.MANAGE_LINE)
    assert "about" not in plugin.fit_text("Edge", "Maya", None).splitlines()[1]


def test_keyboards_one_row_numerals_and_yes_no(plugin):
    rows = plugin.fit_rows("n" * 22, lambda t, d: Button(t, callback_data=d))
    assert len(rows) == 1 and [b.text for b in rows[0]] == ["1", "2", "3", "4", "5"]
    rows = plugin.planned_rows("n" * 22, lambda t, d: Button(t, callback_data=d))
    assert len(rows) == 1 and [b.text for b in rows[0]] == ["Yes", "No"]


def test_mark_keyboard_checks_the_tapped_button_only(plugin):
    nonce = "n" * 22
    rows = plugin.fit_rows(nonce, lambda t, d: Button(t, callback_data=d))
    marked = plugin.mark_keyboard(rows, plugin.fit_callback(4, nonce), lambda t, d: Button(t, callback_data=d))
    assert [b.text for b in marked[0]] == ["1", "2", "3", "✅ 4", "5"]
    again = plugin.mark_keyboard(marked, plugin.fit_callback(2, nonce), lambda t, d: Button(t, callback_data=d))
    assert [b.text for b in again[0]] == ["1", "✅ 2", "3", "4", "5"]


# --------------------------------------------------------------------------- owner


def test_owner_tap_rules(plugin, monkeypatch):
    monkeypatch.setenv("TELEGRAM_HOME_CHANNEL", OWNER)
    assert plugin.is_owner_tap(None, OWNER, OWNER, "private")
    assert not plugin.is_owner_tap(None, OTHER, OTHER, "private")  # not paired (no Hermes here)
    assert not plugin.is_owner_tap(None, OWNER, OTHER, "private")
    assert not plugin.is_owner_tap(None, OWNER, OWNER, "group")
    assert not plugin.is_owner_tap(None, None, OWNER, "private")
    adapter = types.SimpleNamespace(config=types.SimpleNamespace(home_channel={"chat_id": OTHER, "user_id": OTHER}))
    assert plugin.is_owner_tap(adapter, OTHER, OTHER, "private")
    assert plugin.home_chat_id(adapter) == OTHER


# --------------------------------------------------------------------------- stage -> card -> ledger -> record


def test_pickup_sends_card_one_records_the_ledger_and_hands_the_ask_over(plugin, home, on):
    path = stage(home, plugin)
    bot = Bot()
    codes = pickup(plugin, bot)
    assert codes == {"sent": 1}
    assert not path.exists()
    assert len(bot.sent) == 1
    sent = bot.sent[0]
    assert sent["chat_id"] == int(OWNER) and sent["parse_mode"] == "HTML"
    assert "Maya Rao, about Climate finance" in sent["text"]
    assert [b.text for b in sent["reply_markup"].inline_keyboard[0]] == ["1", "2", "3", "4", "5"]
    card = ledger(home)["cards"][OPP]
    assert card["message_id"] == 101 and card["fit"] is None and card["planned"] is None and card["injected"] is False
    assert card["nonce"] == plugin.make_nonce(plugin.hash_key(), OPP)
    assert plugin.epoch_from_iso(card["closes_at"]) == pytest.approx(T0 + 24 * 3600)
    (record,) = records(home)
    assert record == {"event_type": "opportunity.rating_asked", "opportunity_id": OPP, "intention_id": None, "card": "fit", "revision": 1,
                      "value": None, "at": plugin.now_iso(T0), "message_hash": plugin.keyed_hash(plugin.hash_key(), sent["text"])}
    assert "Maya" not in json.dumps(record)
    # A second pass sends nothing more.
    assert pickup(plugin, bot) == {}


def test_pickup_is_off_without_the_switch_and_leaves_the_stage(plugin, home, monkeypatch):
    monkeypatch.setenv("TELEGRAM_HOME_CHANNEL", OWNER)
    path = stage(home, plugin)
    bot = Bot()
    assert pickup(plugin, bot) == {}
    assert path.exists() and not bot.sent


def test_pickup_without_a_home_chat_leaves_the_stage(plugin, home, monkeypatch):
    monkeypatch.setenv("AV_RATE_CARDS", "1")
    path = stage(home, plugin)
    assert pickup(plugin, Bot()) == {"no_home_chat": 1}
    assert path.exists()


@pytest.mark.parametrize("over, code", [
    ({"name": ""}, "stage_dropped_bad_shape"),
    ({"opportunity_id": "has space"}, "stage_dropped_bad_shape"),
    ({"extra": 1}, "stage_dropped_bad_shape"),
    ({"staged_at": "STALE"}, "stage_dropped_stale"),
])
def test_a_stage_not_the_shape_or_stale_is_dropped_and_counted(plugin, home, on, over, code):
    if over.get("staged_at") == "STALE":
        over = {"staged_at": plugin.now_iso(T0 - plugin.STAGE_MAX_AGE_S - 1)}
    path = stage(home, plugin, **over)
    bot = Bot()
    assert pickup(plugin, bot) == {code: 1}
    assert not path.exists() and not bot.sent


def test_a_stage_for_a_card_already_sent_is_dropped(plugin, home, on):
    stage(home, plugin)
    pickup(plugin, Bot())
    path = stage(home, plugin)
    assert pickup(plugin, Bot()) == {"stage_dropped_already_asked": 1}
    assert not path.exists()


def test_send_failures_keep_the_stage_then_drop_it(plugin, home, on):
    path = stage(home, plugin)
    bot = Bot(fail=5)
    assert pickup(plugin, bot) == {"send_failed": 1}
    assert path.exists()
    assert pickup(plugin, bot) == {"send_failed": 1}
    assert pickup(plugin, bot) == {"stage_dropped_send_failed": 1}
    assert not path.exists()


def test_a_private_stage_file_is_required(plugin, home, on):
    path = stage(home, plugin)
    os.chmod(path, 0o644)
    assert pickup(plugin, Bot()) == {"stage_dropped_not_private": 1}


# --------------------------------------------------------------------------- taps


def tapped(plugin, home, on, bot=None):
    stage(home, plugin)
    bot = bot or Bot()
    pickup(plugin, bot)
    return bot, ledger(home)["cards"][OPP]["nonce"]


def test_fit_tap_records_marks_sends_card_two_and_hands_the_event_over(plugin, home, on):
    bot, nonce = tapped(plugin, home, on)
    rows = plugin.fit_rows(nonce, lambda t, d: Button(t, callback_data=d))
    query = Query(plugin.fit_callback(4, nonce), bot, rows=rows)
    run(handler(plugin, now=T0 + 60)(types.SimpleNamespace(callback_query=query)))
    assert query.answers == ["Recorded: Good fit"]
    assert [b.text for b in query.edits[0].inline_keyboard[0]] == ["1", "2", "3", "✅ 4", "5"]
    card = ledger(home)["cards"][OPP]
    assert card["fit"] == {"value": 4, "revision": 1, "at": plugin.now_iso(T0 + 60)}
    assert card["planned_message_id"] == 102
    assert bot.sent[1]["text"] == "Did you already plan this meetup?"
    assert [b.text for b in bot.sent[1]["reply_markup"].inline_keyboard[0]] == ["Yes", "No"]
    kinds = [(r["event_type"], r["card"], r["revision"], r["value"]) for r in records(home)]
    assert kinds == [("opportunity.rating_asked", "fit", 1, None), ("opportunity.rated", "fit", 1, 4), ("opportunity.rating_asked", "planned", 1, None)]
    rated = [r for r in records(home) if r["event_type"] == "opportunity.rated"][0]
    assert rated["at"] == plugin.now_iso(T0 + 60) and rated["message_hash"] is None


def test_a_retap_is_a_revision_and_sends_no_second_card_two(plugin, home, on):
    bot, nonce = tapped(plugin, home, on)
    h = handler(plugin, now=T0 + 60)
    run(h(types.SimpleNamespace(callback_query=Query(plugin.fit_callback(2, nonce), bot))))
    run(h(types.SimpleNamespace(callback_query=Query(plugin.fit_callback(5, nonce), bot))))
    card = ledger(home)["cards"][OPP]
    assert card["fit"] == {"value": 5, "revision": 2, "at": plugin.now_iso(T0 + 60)}
    assert len(bot.sent) == 2
    assert [r["revision"] for r in records(home) if r["event_type"] == "opportunity.rated"] == [1, 2]


def test_planned_tap_records_and_injects_the_line_once(plugin, home, on):
    ctx = Ctx()
    bot, nonce = tapped(plugin, home, on)
    h = handler(plugin, ctx=ctx, now=T0 + 60)
    run(h(types.SimpleNamespace(callback_query=Query(plugin.fit_callback(4, nonce), bot))))
    assert ctx.calls == []
    run(h(types.SimpleNamespace(callback_query=Query(plugin.planned_callback("n", nonce), bot))))
    assert ctx.calls == [("[Rating recorded] Maya Rao: 4/5 match fit; already planned: no.", f"agent:main:telegram:dm:{OWNER}")]
    card = ledger(home)["cards"][OPP]
    assert card["planned"] == {"value": "no", "revision": 1, "at": plugin.now_iso(T0 + 60)} and card["injected"] is True
    planned = [r for r in records(home) if r["event_type"] == "opportunity.pre_planned"]
    assert planned == [{"event_type": "opportunity.pre_planned", "opportunity_id": OPP, "intention_id": None, "card": "planned", "revision": 1,
                        "value": "no", "at": plugin.now_iso(T0 + 60), "message_hash": None}]
    # A revision of card 2 does not inject again.
    run(h(types.SimpleNamespace(callback_query=Query(plugin.planned_callback("y", nonce), bot))))
    assert len(ctx.calls) == 1


def test_injection_refused_or_erroring_never_blocks_the_tap(plugin, home, on):
    for ctx in (Ctx(accept=False), Ctx(raises=True), None):
        for path in (home / "av-events" / "proactive").glob("*.json"):
            path.unlink()
        bot, nonce = tapped(plugin, home, on)
        h = handler(plugin, ctx=ctx, now=T0 + 60)
        run(h(types.SimpleNamespace(callback_query=Query(plugin.fit_callback(1, nonce), bot))))
        query = Query(plugin.planned_callback("y", nonce), bot)
        run(h(types.SimpleNamespace(callback_query=query)))
        assert query.answers == ["Recorded: Yes"]


def test_session_key_override(plugin, monkeypatch):
    assert plugin.session_key_for("42") == "agent:main:telegram:dm:42"
    monkeypatch.setenv("AV_RATE_SESSION_KEY", "agent:prof:telegram:dm:42")
    assert plugin.session_key_for("42") == "agent:prof:telegram:dm:42"


def test_window_closes_after_24_hours_then_the_pickup_injects_card_one_alone(plugin, home, on):
    ctx = Ctx()
    bot, nonce = tapped(plugin, home, on)
    run(handler(plugin, now=T0 + 60)(types.SimpleNamespace(callback_query=Query(plugin.fit_callback(3, nonce), bot))))
    late = Query(plugin.planned_callback("y", nonce), bot)
    run(handler(plugin, now=T0 + 24 * 3600 + 1)(types.SimpleNamespace(callback_query=late)))
    assert late.answers == ["This question has closed."]
    assert ledger(home)["cards"][OPP]["planned"] is None
    assert pickup(plugin, bot, ctx=ctx, now=T0 + 24 * 3600 + 1) == {"injected": 1}
    assert ctx.calls == [("[Rating recorded] Maya Rao: 3/5 match fit; already planned: not answered.", f"agent:main:telegram:dm:{OWNER}")]
    # An unanswered card is never injected.
    stage(home, plugin, opp=OPP2)
    pickup(plugin, bot, now=T0)
    assert pickup(plugin, bot, ctx=ctx, now=T0 + 2 * 24 * 3600) == {}


def test_taps_from_others_unknown_nonces_and_core_buttons(plugin, home, on):
    bot, nonce = tapped(plugin, home, on)
    h = handler(plugin, now=T0 + 60)
    other = Query(plugin.fit_callback(4, nonce), bot, user=OTHER, chat=OTHER)
    run(h(types.SimpleNamespace(callback_query=other)))
    assert other.answers == ["This card is not yours"]
    unknown = Query(plugin.fit_callback(4, "z" * 22), bot)
    run(h(types.SimpleNamespace(callback_query=unknown)))
    assert unknown.answers == ["This card is no longer valid."]
    bad = Query("cp:fast:on", bot)
    run(h(types.SimpleNamespace(callback_query=bad)))
    assert bad.answers == ["This button is not valid."]
    assert ledger(home)["cards"][OPP]["fit"] is None
    assert len(records(home)) == 1


def test_double_tap_in_flight_is_answered_and_recorded_once(plugin, home, on):
    bot, nonce = tapped(plugin, home, on)
    h = handler(plugin, now=T0 + 60)
    first = Query(plugin.fit_callback(4, nonce), bot)
    second = Query(plugin.fit_callback(5, nonce), bot)
    plugin._in_flight.add((OWNER, "101"))
    try:
        run(h(types.SimpleNamespace(callback_query=second)))
    finally:
        plugin._in_flight.discard((OWNER, "101"))
    assert second.answers == ["Still recording..."]
    run(h(types.SimpleNamespace(callback_query=first)))
    assert ledger(home)["cards"][OPP]["fit"]["value"] == 4


def test_register_stores_the_context_and_wires_the_platform_handler(plugin):
    wired = []
    ctx = types.SimpleNamespace(register_platform_handler=lambda platform, factory: wired.append((platform, factory)), inject_message=lambda *a, **k: True)
    plugin.register(ctx)
    assert wired == [("telegram", plugin._wire_telegram)]
    assert plugin._CTX is ctx


def test_logs_carry_codes_only(plugin, home, on, caplog):
    import logging

    caplog.set_level(logging.INFO)
    bot, nonce = tapped(plugin, home, on)
    run(handler(plugin, now=T0 + 60)(types.SimpleNamespace(callback_query=Query(plugin.fit_callback(4, nonce), bot))))
    text = caplog.text
    assert "Maya" not in text and nonce not in text and OWNER not in text and OPP not in text
    assert "outcome=recorded" in text and f"tenant={TENANT[:8]}" in text
