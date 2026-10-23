"""av-godconst: the GODCONST ballot as Telegram button cards (docs/GODCONST-TELEGRAM-BALLOT.md).

Fakes only: the bot, the buttons, the tap and the control plane (a dict-backed ballot that merges taps per statement,
as the app does). One wire test runs the real HTTP client against a loopback server.
"""

from __future__ import annotations

import asyncio
import http.server
import json
import logging
import os
import threading
from datetime import datetime, timezone

import pytest


TEXT = "Statement-Text-Marker"
SHA = "a" * 64
POOL = "11111111-2222-4333-8444-555555555555"
OWNER = 4242
DAY = datetime(2026, 10, 24, 5, 0, tzinfo=timezone.utc).timestamp()  # 10:30 IST
NIGHT = datetime(2026, 10, 24, 18, 0, tzinfo=timezone.utc).timestamp()  # 23:30 IST


def run(coro):
    return asyncio.run(coro)


class Button:
    def __init__(self, text, callback_data):
        self.text, self.callback_data = text, callback_data


class Markup:
    def __init__(self, rows):
        self.inline_keyboard = rows


def make_button(text, data):
    return Button(text, data)


def make_markup(rows):
    return Markup(rows)


class Msg:
    def __init__(self, message_id, chat_id, text, markup, bot):
        self.message_id, self.text, self.reply_markup, self._bot = message_id, text, markup, bot
        self.chat = type("Chat", (), {"id": chat_id, "type": "private"})()

    def get_bot(self):
        return self._bot


class Bot:
    def __init__(self):
        self.sent, self.edits, self.fail = [], [], 0
        self._next = 100

    async def send_message(self, chat_id, text, parse_mode=None, reply_markup=None, disable_web_page_preview=None):
        if self.fail:
            self.fail -= 1
            raise RuntimeError("Forbidden: bot was blocked by the user")
        self._next += 1
        msg = Msg(self._next, chat_id, text, reply_markup, self)
        self.sent.append(msg)
        return msg

    async def edit_message_reply_markup(self, chat_id, message_id, reply_markup):
        self.edits.append((message_id, reply_markup))

    def cards(self):
        return [m for m in self.sent if m.reply_markup and m.reply_markup.inline_keyboard[0][0].callback_data.startswith("gcb:r:")]


class Server:
    """The app behind the control plane: one resident's ballot, merged per statement."""

    def __init__(self, plugin, n=6):
        self.P = plugin
        self.state = "open"
        self.order = [f"s{i:03d}" for i in range(1, n + 1)]
        self.ratings = {}
        self.calls = []
        self.refuse = None

    def view(self):
        return {
            "state": self.state,
            "pool": {"id": POOL, "sha256": SHA, "rating_closes_at": "2026-10-25T05:00:00.000Z", "n_statements": len(self.order), "order_rule": "godconst-order-v2"},
            "categories": [{"id": "care", "label": "Care"}],
            "statements": [{"id": sid, "category": "care", "text": f"{TEXT} {sid}", "author_type": "odin"} for sid in self.order] if self.state == "open" else [],
            "ratings": dict(self.ratings),
            "revision": len(self.ratings),
        }

    def __call__(self, op, body, home=None):
        self.calls.append((op, dict(body)))
        if self.refuse:
            status, code = self.refuse
            return self.P.Reply(status, {"error": code}, code)
        if op == "read":
            return self.P.Reply(200, self.view(), self.state)
        if op == "submit":
            if not self.ratings:
                return self.P.Reply(422, {"error": "incomplete"}, "incomplete")
            self.state = "submitted"
            return self.P.Reply(200, {"state": "submitted", "revision": 10, "n_rated": len(self.ratings), "n_statements": len(self.order), "progress": {}}, "submitted")
        if self.state == "submitted":
            return self.P.Reply(409, {"error": "submitted"}, "submitted")
        assert body["pool_sha256"] == SHA
        self.ratings[body["statement_id"]] = body["rating"]
        return self.P.Reply(200, {"state": "saved", "unchanged": False, "revision": 9, "ratings": dict(self.ratings),
                                  "progress": {"answered": len(self.ratings), "total": len(self.order), "missing": 0}}, "saved")


class Query:
    def __init__(self, data, message, user=OWNER, chat_type="private"):
        self.data, self.message = data, message
        self.from_user = type("U", (), {"id": user})()
        if chat_type != "private":
            message.chat.type = chat_type
        self.answers, self.edited = [], []

    async def answer(self, text=None):
        self.answers.append(text)

    async def edit_message_reply_markup(self, reply_markup=None):
        self.edited.append(reply_markup)
        self.message.reply_markup = reply_markup


def tap(P, bot, server, msg, value, *, user=OWNER, data=None, clock=DAY):
    position_data = data or msg.reply_markup.inline_keyboard[0][value - 1].callback_data
    q = Query(position_data, msg, user=user)
    handler = P.make_handler(None, make_button=make_button, make_markup=make_markup, caller=server, clock=lambda: clock)
    run(handler(type("Update", (), {"callback_query": q})()))
    return q


def start(P, bot, server, now=DAY):
    P._last_read["at"] = 0.0
    return run(P.pass_once(bot, None, make_button, make_markup, now=now, reader=server))


def ledger_text(home):
    with open(os.path.join(home, "av-godconst", "ballot.json"), encoding="utf-8") as handle:
        return handle.read()


# --------------------------------------------------------------------------- pure logic


def test_callback_data_round_trip_bounds_and_refusals(plugin):
    L = plugin.L
    assert L.parse_callback(L.rating_callback("AbCd_-12", 29, 5)) == ("rate", "AbCd_-12", 29, 5)
    assert L.parse_callback("gcb:x:AbCd_-12") == ("stop", "AbCd_-12")
    assert L.parse_callback("gcb:g:AbCd_-12") == ("resume", "AbCd_-12")
    assert len(L.rating_callback("AbCd_-12", 499, 5).encode()) <= 64
    for bad in ("gcb:r:AbCd_-12:1:6", "gcb:r:AbCd_-12:01:3", "gcb:r:short:1:3", "gcb:r:AbCd_-12:1000:3", "avr:f:1:x", None, 7, "gcb:z:AbCd_-12", "gcb:" + "x" * 70):
        assert L.parse_callback(bad) is None


def test_pages_are_pairs_and_skip_what_the_web_page_rated(plugin):
    L = plugin.L
    assert L.PAGE_SIZE == 2
    assert [L.page_positions(p, 5) for p in range(3)] == [[0, 1], [2, 3], [4]]
    assert L.next_page(-1, 6, set()) == 0
    assert L.next_page(0, 6, {0, 1, 2, 3}) == 2
    assert L.next_page(0, 6, {0, 1, 2, 3, 4, 5}) is None
    assert L.page_done(-1, 6, set()) and not L.page_done(0, 6, {0}) and L.page_done(0, 6, {0, 1})
    assert L.to_send(1, 6, {2}, ["0", "1"]) == [3]


def test_view_shape_is_checked_and_authorship_never_kept(plugin):
    server = Server(plugin)
    view = plugin.L.valid_view(server.view())
    assert view["statements"][0] == {"id": "s001", "category": "care", "text": f"{TEXT} s001"}
    assert view["pool"]["order_rule"] == "godconst-order-v2"
    for broken in ({"state": "maybe"}, {**server.view(), "ratings": {"s001": 6}}, {**server.view(), "pool": {"id": "x", "sha256": SHA}},
                   {**server.view(), "statements": []}, {**server.view(), "statements": [{"id": "s001", "category": "care", "text": ""}]}):
        assert plugin.L.valid_view(broken) is None
    assert plugin.L.valid_view({"state": "no_pool", "ratings": {}})["state"] == "no_pool"


# --------------------------------------------------------------------------- start


def test_start_sends_the_header_and_the_first_pair_and_keeps_no_text_or_value(plugin, home):
    bot, server = Bot(), Server(plugin)
    assert start(plugin, bot, server) == "open"
    header, *cards = bot.sent
    assert "Village constitution: 6 statements to rate" in header.text
    assert "5  Strongly support inclusion" in header.text and "Open until 10:30 IST, Sun 25 Oct." in header.text
    assert [b.text for b in header.reply_markup.inline_keyboard[0]] == ["Submit my ratings", "Stop these cards"]
    assert [c.text.splitlines()[0] for c in cards] == ["Statement 1 of 6 · Care", "Statement 2 of 6 · Care"]
    assert f"{TEXT} s001" in cards[0].text and "odin" not in cards[0].text.lower()
    assert [b.text for b in cards[0].reply_markup.inline_keyboard[0]] == ["1", "2", "3", "4", "5"]
    # The last card of each page carries Submit on a second row.
    assert len(cards[0].reply_markup.inline_keyboard) == 1 and cards[1].reply_markup.inline_keyboard[1][0].text == "Submit my ratings"
    stored = ledger_text(home)
    assert TEXT not in stored and '"ratings"' not in stored and "mark" not in stored
    assert sorted(os.listdir(os.path.join(home, "av-godconst"))) == ["ballot.json"]  # no key on disk
    assert oct(os.stat(os.path.join(home, "av-godconst", "ballot.json")).st_mode & 0o777) == "0o600"
    # A second pass before it is due reads nothing; when due, nothing new is sent while the pair is unrated.
    assert run(plugin.pass_once(bot, None, make_button, make_markup, now=DAY + 10, reader=server)) == "not_due"
    assert start(plugin, bot, server, now=DAY + 400) == "open"
    assert len(bot.sent) == 3


def test_no_first_card_at_night_off_or_not_open(plugin, home, monkeypatch):
    bot, server = Bot(), Server(plugin)
    assert start(plugin, bot, server, now=NIGHT) == "open"
    assert bot.sent == []
    for state in ("no_pool", "not_participant", "closed"):
        server.state = state
        assert start(plugin, bot, server) == state
    assert bot.sent == []
    monkeypatch.setenv("AV_GODCONST_BALLOT", "0")
    assert start(plugin, bot, server) == "off"
    assert server.calls[-1] == ("read", {})  # the last read was before the switch went off


def test_all_rated_on_the_web_already_sends_nothing(plugin, home):
    bot, server = Bot(), Server(plugin, n=2)
    server.ratings = {"s001": 3, "s002": 4}
    start(plugin, bot, server)
    assert bot.sent == []
    assert json.loads(ledger_text(home))["session"]["status"] == "done"


# --------------------------------------------------------------------------- taps


def test_a_rated_pair_brings_the_next_pair_and_a_retap_is_a_revision(plugin, home):
    bot, server = Bot(), Server(plugin)
    start(plugin, bot, server)
    first, second = bot.cards()
    q = tap(plugin, bot, server, first, 4)
    assert q.answers == ["Saved: Support inclusion"]
    assert [b.text for b in q.edited[0].inline_keyboard[0]] == ["1", "2", "3", "✅ 4", "5"]
    assert server.ratings == {"s001": 4}
    assert len(bot.cards()) == 2
    tap(plugin, bot, server, second, 1)
    assert [c.text.splitlines()[0] for c in bot.cards()[2:]] == ["Statement 3 of 6 · Care", "Statement 4 of 6 · Care"]
    q = tap(plugin, bot, server, first, 2)
    assert q.answers == ["Saved: Oppose inclusion (changed)"]
    assert server.ratings["s001"] == 2 and len(bot.cards()) == 4
    assert ("rate", {"pool_sha256": SHA, "statement_id": "s001", "rating": 2}) in server.calls
    assert TEXT not in ledger_text(home)


def test_the_last_pair_ends_with_one_line(plugin, home):
    bot, server = Bot(), Server(plugin, n=4)
    start(plugin, bot, server)
    for value, card in zip((5, 4), bot.cards()):
        tap(plugin, bot, server, card, value)
    for value, card in zip((3, 1), bot.cards()[2:]):
        tap(plugin, bot, server, card, value)
    assert bot.sent[-1].text.startswith("All 4 statements rated. Thank you.")
    assert bot.sent[-1].reply_markup.inline_keyboard[0][0].text == "Submit my ratings"
    tap(plugin, bot, server, bot.cards()[0], 2)
    assert sum("statements rated" in m.text for m in bot.sent) == 1
    assert json.loads(ledger_text(home))["session"]["status"] == "done"


def test_a_pair_rated_on_the_web_is_skipped_and_web_changes_re_mark_cards(plugin, home):
    bot, server = Bot(), Server(plugin)
    start(plugin, bot, server)
    server.ratings.update({"s003": 2, "s004": 5})  # the web page rated pair 2
    first, second = bot.cards()
    tap(plugin, bot, server, first, 4)
    tap(plugin, bot, server, second, 4)
    assert [c.text.splitlines()[0] for c in bot.cards()[2:]] == ["Statement 5 of 6 · Care", "Statement 6 of 6 · Care"]
    server.ratings["s001"] = 1  # changed on the web page
    start(plugin, bot, server, now=DAY + 1000)
    message_id, markup = [e for e in bot.edits if e[0] == first.message_id][-1]
    assert [b.text for b in markup.inline_keyboard[0]] == ["✅ 1", "2", "3", "4", "5"]
    # After a restart (memory gone) every sent card is redrawn from the app, the Submit row kept.
    plugin._SHOWN.clear()
    before = len(bot.edits)
    start(plugin, bot, server, now=DAY + 2000)
    redrawn = {e[0]: e[1] for e in bot.edits[before:]}
    assert len(redrawn) == 4 and [b.text for b in redrawn[second.message_id].inline_keyboard[0]][3] == "✅ 4"
    assert redrawn[second.message_id].inline_keyboard[1][0].text == "Submit my ratings"


def test_only_the_owner_in_their_own_dm(plugin, home):
    bot, server = Bot(), Server(plugin)
    start(plugin, bot, server)
    card = bot.cards()[0]
    calls = len(server.calls)
    assert tap(plugin, bot, server, card, 3, user=999).answers == ["This card is not yours"]
    q = Query(card.reply_markup.inline_keyboard[0][2].callback_data, card)
    card.chat.type = "group"
    run(plugin.make_handler(None, make_button=make_button, make_markup=make_markup, caller=server)(type("U", (), {"callback_query": q})()))
    assert q.answers == ["This card is not yours"]
    assert len(server.calls) == calls


def test_old_cards_bad_buttons_and_refusals(plugin, home):
    bot, server = Bot(), Server(plugin)
    start(plugin, bot, server)
    card = bot.cards()[0]
    assert tap(plugin, bot, server, card, 3, data="gcb:r:ZZZZZZZZ:0:3").answers == ["This card is from an earlier ballot."]
    assert tap(plugin, bot, server, card, 3, data="gcb:r:nonsense").answers == ["This button is not valid."]
    server.refuse = (403, "not_enabled")
    assert tap(plugin, bot, server, card, 3).answers == ["Rating by Telegram is off right now. You can still rate on the Constitution page."]
    assert json.loads(ledger_text(home))["session"] is not None  # a switch is not an ending
    server.refuse = (409, "submitted")
    assert tap(plugin, bot, server, card, 3).answers == ["Your ballot is submitted, so rating is closed for you."]
    stored = json.loads(ledger_text(home))
    assert stored["session"] is None and stored["ended"]["status"] == "submitted" and set(stored["ended"]) == {"pool_sha256", "nonce", "status", "at"}
    server.refuse = None
    assert tap(plugin, bot, server, card, 4).answers == ["Your ballot is submitted, so rating is closed for you."]


def test_withdrawal_and_close_settle_the_session_without_a_message(plugin, home):
    bot, server = Bot(), Server(plugin)
    start(plugin, bot, server)
    sent = len(bot.sent)
    server.refuse = (403, "consent_withdrawn")
    assert start(plugin, bot, server, now=DAY + 400) == "consent_withdrawn"
    assert json.loads(ledger_text(home))["ended"]["status"] == "withdrawn"
    plugin.save_ledger({"v": 1, "session": None})
    server.refuse = None
    start(plugin, bot, server)
    server.state = "closed"
    start(plugin, bot, server, now=DAY + 1000)
    stored = json.loads(ledger_text(home))
    assert stored["session"] is None and stored["ended"]["status"] == "closed"
    assert len(bot.sent) == sent + 3  # the restart's header and pair only
    # The pool reopening (or a stale read) never restarts a ballot that ended on this box.
    server.state = "open"
    start(plugin, bot, server, now=DAY + 2000)
    assert len(bot.sent) == sent + 3


def test_stop_and_resume(plugin, home):
    bot, server = Bot(), Server(plugin)
    start(plugin, bot, server)
    header = bot.sent[0]
    q = tap(plugin, bot, server, header, 1, data=header.reply_markup.inline_keyboard[0][1].callback_data)
    assert q.answers == ["Stopped. Your ratings are kept."]
    assert q.edited[0].inline_keyboard[0][1].text == "Resume these cards"
    assert bot.sent[-1].text.startswith("Stopped: no more statement cards.")
    for card, value in zip(bot.cards(), (2, 3)):
        tap(plugin, bot, server, card, value)
    assert len(bot.cards()) == 2 and server.ratings == {"s001": 2, "s002": 3}
    tap(plugin, bot, server, header, 1, data=header.reply_markup.inline_keyboard[0][1].callback_data)
    start(plugin, bot, server, now=DAY + 2000)
    assert len(bot.cards()) == 4


def test_a_blocked_bot_retries_then_gives_up(plugin, home):
    bot, server = Bot(), Server(plugin)
    start(plugin, bot, server)
    first, second = bot.cards()
    tap(plugin, bot, server, first, 4)
    bot.fail = 10
    tap(plugin, bot, server, second, 4)
    for i in range(3):
        start(plugin, bot, server, now=DAY + 1000 * (i + 1))
    assert json.loads(ledger_text(home))["session"]["status"] == "undeliverable"


def test_logs_carry_codes_never_text_values_or_ids(plugin, home, caplog):
    caplog.set_level(logging.INFO)
    bot, server = Bot(), Server(plugin)
    start(plugin, bot, server)
    for card, value in zip(bot.cards(), (4, 5)):
        tap(plugin, bot, server, card, value)
    lines = "\n".join(r.getMessage() for r in caplog.records)
    assert "outcome=saved" in lines and "outcome=sync" in lines
    for secret in (TEXT, "s001", "Support", str(OWNER), "0190a5b2-aaaa", "gcb:"):
        assert secret not in lines


# --------------------------------------------------------------------------- the wire


def test_cp_origin_is_pinned(plugin):
    assert plugin.cp_origin("https://control-plane-production-606c.up.railway.app") == "https://control-plane-production-606c.up.railway.app"
    for bad in ("https://evil.example", "http://control-plane-production-606c.up.railway.app", "https://control-plane-production-606c.up.railway.app/x",
                "https://u:p@control-plane-production-606c.up.railway.app", "https://control-plane-production-606c.up.railway.app:8443", ""):
        assert plugin.cp_origin(bad) is None
    assert plugin.cp_origin("http://127.0.0.1:9") == "http://127.0.0.1:9"


def test_cp_call_posts_the_box_key_to_its_own_tenant(plugin, home, monkeypatch):
    seen = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            body = self.rfile.read(int(self.headers["Content-Length"]))
            seen.append((self.path, self.headers["Authorization"], json.loads(body)))
            status, payload = (200, {"state": "saved", "ratings": {}}) if self.path.endswith("/rate") else (409, {"error": "stale_pool"})
            raw = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        assert plugin.cp_call("read", {}).code == "not_configured"
        monkeypatch.setenv("CONTROL_PLANE_URL", f"http://127.0.0.1:{server.server_port}")
        monkeypatch.setenv("AV_GODCONST_BALLOT_KEY", "ballot_key_box")
        monkeypatch.setenv("EDGEOS_API_KEY", "eos_live_box_key")
        rate = plugin.cp_call("rate", {"pool_sha256": SHA, "statement_id": "s001", "rating": 3})
        read = plugin.cp_call("read", {})
    finally:
        server.shutdown()
    assert (rate.status, rate.code, rate.ok) == (200, "saved", True)
    assert (read.status, read.code, read.ok) == (409, "stale_pool", False)
    tenant = "0190a5b2-aaaa-4222-8333-444455556666"
    assert seen == [
        (f"/tenants/{tenant}/godconst/ballot/rate", "Bearer ballot_key_box", {"pool_sha256": SHA, "statement_id": "s001", "rating": 3}),
        (f"/tenants/{tenant}/godconst/ballot", "Bearer ballot_key_box", {}),
    ]


def test_register_wires_one_platform_handler(plugin):
    wired = []
    plugin.register(type("Ctx", (), {"register_platform_handler": lambda self, platform, factory: wired.append((platform, factory))})())
    assert [w[0] for w in wired] == ["telegram"]


def test_submit_asks_then_submits_the_merged_draft_and_forgets_the_ballot(plugin, home):
    bot, server = Bot(), Server(plugin)
    start(plugin, bot, server)
    first, second = bot.cards()
    submit_data = second.reply_markup.inline_keyboard[1][0].callback_data
    server.ratings["s005"] = 2  # rated on the web page: the box re-reads, so the count is the app's
    assert tap(plugin, bot, server, second, 1, data=submit_data).answers == ["Confirm below."]
    confirm = bot.sent[-1]
    assert confirm.text.startswith("Submit your ratings now? You rated 1 of 6")
    server.ratings.clear()
    yes, no = confirm.reply_markup.inline_keyboard[0]
    assert tap(plugin, bot, server, confirm, 1, data=yes.callback_data).answers == ["Rate at least one statement before you submit."]
    assert tap(plugin, bot, server, confirm, 1, data=no.callback_data).answers == ["Not submitted. You can keep rating."]
    tap(plugin, bot, server, first, 4)
    q = tap(plugin, bot, server, confirm, 1, data=yes.callback_data)
    assert q.answers == ["Submitted"] and q.edited == [None]
    assert bot.sent[-1].text == "Submitted: 1 of 6 rated. Thank you: your ratings are final."
    assert ("submit", {"pool_sha256": SHA}) in server.calls
    stored = json.loads(ledger_text(home))
    assert stored["session"] is None and stored["ended"]["status"] == "submitted"
    assert "s001" not in ledger_text(home)
    calls = len(server.calls)
    assert tap(plugin, bot, server, second, 5).answers == ["Your ballot is submitted, so rating is closed for you."]
    assert len(server.calls) == calls


def test_the_window_closing_forgets_the_ballot(plugin, home):
    bot, server = Bot(), Server(plugin)
    start(plugin, bot, server)
    card = bot.cards()[0]
    after = datetime(2026, 10, 25, 5, 1, tzinfo=timezone.utc).timestamp()
    assert tap(plugin, bot, server, card, 3, clock=after).answers == ["Rating has closed."]
    assert json.loads(ledger_text(home))["ended"]["status"] == "closed"
    assert all(op != "rate" for op, _ in server.calls)
    plugin.save_ledger({"v": 1, "session": None})
    start(plugin, bot, server)
    assert run(plugin.pass_once(bot, None, make_button, make_markup, now=after, reader=server)) == "window_over"
    assert json.loads(ledger_text(home))["session"] is None


def test_an_app_404_on_save_ends_the_ballot_as_withdrawn(plugin, home):
    bot, server = Bot(), Server(plugin)
    start(plugin, bot, server)
    server.refuse = (404, "not_found")
    assert tap(plugin, bot, server, bot.cards()[0], 3).answers == ["You can't take part right now."]
    assert json.loads(ledger_text(home))["ended"]["status"] == "withdrawn"


def test_the_page_open_marker_follows_the_open_page(plugin, home):
    marker = os.path.join(home, "av-events", "godconst", "page-open")
    bot, server = Bot(), Server(plugin, n=4)
    start(plugin, bot, server)
    assert os.path.isfile(marker) and os.path.getsize(marker) == 0 and oct(os.stat(marker).st_mode & 0o777) == "0o600"
    first, second = bot.cards()
    tap(plugin, bot, server, first, 4)
    assert os.path.exists(marker)  # one card of the pair still unrated
    server.ratings["s002"] = 3  # rated on the web: the next read sees the page complete, then sends the next pair
    start(plugin, bot, server, now=DAY + 400)
    assert len(bot.cards()) == 4 and os.path.exists(marker)
    # Stop: the resident asked for no more cards, so the opener is not held.
    header = bot.sent[0]
    tap(plugin, bot, server, header, 1, data=header.reply_markup.inline_keyboard[0][1].callback_data)
    assert not os.path.exists(marker)
    tap(plugin, bot, server, header, 1, data=header.reply_markup.inline_keyboard[0][1].callback_data)
    assert os.path.exists(marker)
    # A complete page removes it (here the last pair: the final line follows, no new page).
    third, fourth = bot.cards()[2:]
    tap(plugin, bot, server, third, 2)
    assert os.path.exists(marker)
    tap(plugin, bot, server, fourth, 2)
    assert not os.path.exists(marker)
    assert bot.sent[-1].text.startswith("All 4 statements rated.")


def test_the_marker_goes_on_submit_window_close_and_withdrawal(plugin, home):
    marker = os.path.join(home, "av-events", "godconst", "page-open")
    for ending in ("submit", "window", "withdrawal"):
        plugin.save_ledger({"v": 1, "session": None})
        bot, server = Bot(), Server(plugin)
        start(plugin, bot, server)
        assert os.path.exists(marker), ending
        first, second = bot.cards()
        if ending == "submit":
            tap(plugin, bot, server, first, 4)
            submit = second.reply_markup.inline_keyboard[1][0].callback_data
            tap(plugin, bot, server, second, 1, data=submit)
            yes = bot.sent[-1].reply_markup.inline_keyboard[0][0].callback_data
            tap(plugin, bot, server, bot.sent[-1], 1, data=yes)
        elif ending == "window":
            after = datetime(2026, 10, 25, 5, 1, tzinfo=timezone.utc).timestamp()
            assert run(plugin.pass_once(bot, None, make_button, make_markup, now=after, reader=server)) == "window_over"
        else:
            server.refuse = (403, "consent_withdrawn")
            tap(plugin, bot, server, first, 4)
        assert not os.path.exists(marker), ending


def test_each_page_touches_the_marker_and_start_up_removes_a_stale_one(plugin, home):
    marker = os.path.join(home, "av-events", "godconst", "page-open")
    bot, server = Bot(), Server(plugin)
    start(plugin, bot, server)
    os.utime(marker, (1, 1))
    first, second = bot.cards()
    tap(plugin, bot, server, first, 4)
    tap(plugin, bot, server, second, 4)  # the next pair goes out: the marker is touched
    assert os.stat(marker).st_mtime > 1000
    # Start-up: an open page inside the window keeps it ...
    assert plugin.reconcile_page_open(now=DAY + 100) is True and os.path.exists(marker)
    # ... the window over, no session, or an unreadable ledger removes it.
    after = datetime(2026, 10, 25, 5, 1, tzinfo=timezone.utc).timestamp()
    assert plugin.reconcile_page_open(now=after) is False and not os.path.exists(marker)
    plugin.set_page_open(True)
    plugin.save_ledger({"v": 1, "session": None})
    plugin.register(type("Ctx", (), {"register_platform_handler": lambda self, platform, factory: None})())
    assert not os.path.exists(marker)
    plugin.set_page_open(True)
    os.chmod(plugin.ledger_path(), 0o644)
    assert plugin.reconcile_page_open(now=DAY) is False and not os.path.exists(marker)
