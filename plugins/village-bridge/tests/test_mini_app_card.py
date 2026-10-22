"""CARD-OV: the ONE generic approval card on the box (mini-apps v2 Phase 1 item 6). The shared golden vectors byte for
byte through card_fields; authorize_action (member class, `requested` only, `autonomous` refused, wait/start with grant,
executed replay); the per-app draft cache; the generic dispatch in handle(); the generic on-grant pass and its line;
adaptive polling. Offline: a fake daemon, a fake app, no Telegram. All data invented."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import time
import types
import unittest
from unittest.mock import Mock, patch

fixture = sys.modules.get('village_bridge_test_fixture')
if fixture is None:
    _spec = importlib.util.spec_from_file_location('village_bridge_test_fixture', Path(__file__).with_name('test_bridge.py'))
    fixture = importlib.util.module_from_spec(_spec)
    sys.modules[_spec.name] = fixture
    _spec.loader.exec_module(fixture)
bridge, mini = fixture.bridge, fixture.mini
fk = sys.modules['village_bridge._forkicks']
fkg = sys.modules['village_bridge._forkicks_grant']
mc = sys.modules['village_bridge._mini_app_card']
mg = sys.modules['village_bridge._mini_app_grant']

VECTORS = json.loads(Path(__file__).with_name('vectors').joinpath('mini-app-card.json').read_text(encoding='utf-8'))
FK_VECTORS = json.loads(Path(__file__).with_name('vectors').joinpath('forkicks-approval-card.json').read_text(encoding='utf-8'))


def vector(name):
    return copy.deepcopy(next(v for v in VECTORS['vectors'] if v['name'].startswith(name)))


BASE = vector('acme: a generic app')
DECL, REQUEST, CARD = BASE['declaration'], BASE['request'], BASE['card']
DRAFT = '7c1e2a40-0000-4000-8000-00000000a001'
TASK = 'propose:' + 'c' * 32
PREPARE, CONFIRM = 'acme.rental.prepare', 'acme.rental.confirm'
CLASS = 'marketplace.app.action.acme.rental.confirm'
KEY = CLASS + ':' + DRAFT
APP = {'id': 'acme', 'name': 'Acme Kayaks', 'operations': [
    {'name': PREPARE, 'class': 'prepare'},
    {'name': CONFIRM, 'class': 'needs-card', 'prepare': PREPARE, 'card': DECL}]}
RECEIPT = {'id': 'rental-77', 'summary': 'Kayak k-2 booked, 2 hours'}


def hashed(payload):
    return hashlib.sha256(fk.canonical(payload).encode()).hexdigest()


def answer(exit_code=0, **doc):
    return types.SimpleNamespace(ok=exit_code == 0 and doc.get('ok') is True, doc=doc, exit_code=exit_code, status=doc.get('status'))


# ---- 1. the shared golden vectors ------------------------------------------------------------------------------------


class GoldenVectorTest(unittest.TestCase):
    def test_every_golden_vector_byte_for_byte(self):
        self.assertEqual(VECTORS['valueMax'], fk.CARD_VALUE_MAX)
        self.assertEqual((VECTORS['summaryMaxBytes'], VECTORS['summaryHtmlMaxBytes']), (fk.SUMMARY_MAX_BYTES, fk.SUMMARY_HTML_MAX_BYTES))
        self.assertEqual(VECTORS['labels'], mc.LABELS)
        self.assertGreaterEqual(len(VECTORS['vectors']), 50)
        for v in VECTORS['vectors']:
            with self.subTest(v['name']):
                if 'card' in v:
                    fields = mc.card_fields(v['declaration'], v['preview'], v.get('request'))
                    self.assertEqual(fields, v['card'])
                    self.assertEqual(list(fields), ['item', 'total', 'when', 'shared'])
                    self.assertEqual(mc.payload_hash(fields), v['payloadHash'])
                    self.assertEqual(mc.card_summary(fields), v['summary'])
                else:
                    with self.assertRaisesRegex(ValueError, '^' + v['error'] + '$'):
                        mc.card_fields(v['declaration'], v['preview'], v.get('request'))

    def test_every_rule_has_a_vector(self):
        names = [v['name'] for v in VECTORS['vectors']]
        for needle in ('missing path', 'non-string value', 'neither shown nor bound', 'forkicks through a declaration',
                       'declaration absent', 'bound value differs', '279 code points', 'too long'):
            self.assertTrue(any(needle in n for n in names), needle)

    def test_for_kicks_preview_through_a_declaration_is_for_kicks_own_card(self):
        # One engine renders both: For Kicks' own vector strings come out of the generic declaration unchanged.
        for fk_name, name in (('target-card', 'forkicks through a declaration (target-card)'),
                              ('two lines, one without options', 'forkicks through a declaration (two lines)')):
            own = next(v for v in FK_VECTORS['vectors'] if v['name'].startswith(fk_name))
            self.assertEqual(fk.card_fields(own['preview']), own['card'])
            generic = vector(name)
            self.assertEqual(mc.card_fields(generic['declaration'], generic['preview'], generic['request']),
                             {'item': own['card']['order'], 'total': own['card']['total'], 'when': own['card']['pickup'], 'shared': own['card']['name']})

    def test_fit_rules_are_for_kicks_own_by_import(self):
        self.assertIs(mc.card_value_fits, fk.card_value_fits)
        self.assertIs(mc.card_name_fakes_line, fk.card_name_fakes_line)
        self.assertIs(mc.canonical, fk.canonical)

    def test_member_class_and_key(self):
        self.assertEqual(mc.member_class(CONFIRM), CLASS)
        self.assertEqual(mc.action_key(CONFIRM, DRAFT), KEY)
        self.assertTrue(KEY.startswith(CLASS + ':'))  # the daemon requires the key to start with "<class>:"


# ---- 2. the projection: dark on every v1 box -------------------------------------------------------------------------


class ProjectionTest(unittest.TestCase):
    def test_v1_projection_carries_no_class_so_nothing_is_generic(self):
        for op in (PREPARE, CONFIRM, 'forkicks.order.confirm', 'gold-stars.send', 'mini-app.read', 'acme', None, 3):
            self.assertIsNone(mc.projected_operation(Path('/nonexistent'), op))

    def test_op_records_are_checked(self):
        with patch.object(mc, 'projected_app', return_value=APP):
            self.assertEqual(mc.projected_operation(Path('/x'), CONFIRM), ('acme', APP, APP['operations'][1]))
            self.assertEqual(mc.projected_operation(Path('/x'), PREPARE)[2]['class'], 'prepare')
            self.assertIsNone(mc.projected_operation(Path('/x'), 'acme.rental.status'))
        for bad in ({**APP['operations'][1], 'class': 'write'}, {**APP['operations'][1], 'extra': 1},
                    {k: v for k, v in APP['operations'][1].items() if k != 'prepare'}):
            with self.subTest(bad=bad), patch.object(mc, 'projected_app', return_value={**APP, 'operations': [APP['operations'][0], bad]}):
                self.assertIsNone(mc.projected_operation(Path('/x'), CONFIRM))
        # A reviewed app never takes the generic path, whatever a projection says.
        for reviewed in ('forkicks', 'gold-stars', 'zzzbot', 'slopfolio'):
            with patch.object(mc, 'projected_app', return_value={'id': reviewed, 'operations': [{'name': reviewed + '.x.confirm', 'class': 'needs-card', 'prepare': reviewed + '.x.prepare', 'card': DECL}]}):
                self.assertIsNone(mc.projected_operation(Path('/x'), reviewed + '.x.confirm'))

    def test_app_name_is_cleaned_or_the_fallback(self):
        self.assertEqual(mc.app_name(APP), 'Acme Kayaks')
        self.assertEqual(mc.app_name({'name': '**Acme** <Kayaks>\n'}), 'Acme Kayaks')
        for bad in ({'name': 'x' * 41}, {'name': 3}, {'name': '***'}, {}, None):
            self.assertEqual(mc.app_name(bad), mc.APP_NAME_FALLBACK)


# ---- the fakes -------------------------------------------------------------------------------------------------------


class Daemon:
    """approval.md as the box sees it: a member class pinned to ask (`requested`), or no row yet (`autonomous`)."""

    def __init__(self, decision='requested'):
        self.decision, self.state, self.authorization = decision, 'requested', 'grant'
        self.propose = Mock(side_effect=self._propose)
        self.wait = Mock(side_effect=self._wait)
        self.start = Mock(side_effect=self._start)

    def _propose(self, cls, key, summary, payload):
        return answer(0, ok=True, task=TASK, decision=self.decision, state='executed' if self.state == 'started' else None,
                      payload_hash=hashlib.sha256(payload.encode()).hexdigest())

    def _wait(self, task):
        if self.state == 'requested':
            return answer(6, ok=False, task=task, status='requested')
        if self.state == 'granted':
            return answer(0, ok=True, task=task, status='granted', actions=[{'action_key': KEY, 'state': 'granted'}])
        if self.state == 'started':
            return answer(0, ok=True, task=task, status='nothing-to-wait-for', actions=[{'action_key': KEY, 'state': 'granted'}])
        code = {'rejected': 1, 'revoked': 1, 'withdrawn': 1, 'expired': 3, 'void': 7}[self.state]
        return answer(code, ok=True, task=task, status=self.state, actions=[{'action_key': KEY, 'state': self.state}])

    def _start(self, task, key, held):
        if self.state != 'granted':
            return answer(1, ok=False, error={'code': 'not-granted'})
        self.state = 'started'
        return answer(0, ok=True, task=task, action_key=key, authorization=self.authorization)


class Base(unittest.TestCase):
    setUp_bridge = fixture.BridgeTest.setUp
    call = fixture.BridgeTest.call

    def setUp(self):
        self.setUp_bridge()
        self.home = Path(self.tmp.name)
        self.app = copy.deepcopy(APP)
        p = patch.object(mc, 'projected_app', side_effect=lambda home, app_id: self.app if app_id == 'acme' else None)
        p.start(); self.addCleanup(p.stop)
        for target, name, value in ((bridge, 'gate_verified', None), (bridge, '_ensure_mini_app_pass', True)):
            p = patch.object(target, name, return_value=value); p.start(); self.addCleanup(p.stop)
        self.daemon = Daemon()
        for module in (mc, mg):
            p = patch.object(module, 'approval_modules', return_value=self.daemon); p.start(); self.addCleanup(p.stop)
        self.sent = []
        p = patch.object(mg, '_telegram_dm', side_effect=lambda owner, text: self.sent.append((owner, text)) or True)
        p.start(); self.addCleanup(p.stop)
        self.events = []
        mg.set_emitter(self.events.append); self.addCleanup(mg.set_emitter, None)
        self.orders = 0
        self.transport.side_effect = self.app_server

    def prepared(self, card=None, preview=None, expires='2099-01-01T00:00:00+05:30'):
        preview = {'appId': 'acme', 'draftId': DRAFT, **copy.deepcopy(BASE['preview'] if preview is None else preview)}
        card = dict(CARD if card is None else card)
        return {'draftId': DRAFT, 'approvalPayload': card, 'payloadHash': hashed(card), 'preview': preview, 'expiresAt': expires}

    def app_server(self, config, payload, **kwargs):
        if payload['operation'] == PREPARE:
            return self.prepare_answer
        self.orders += 1
        return {'draftId': DRAFT, 'receipt': dict(RECEIPT), 'replayed': self.orders > 1}

    def prepare(self, **kw):
        self.sc._VAR_MAP['HERMES_SESSION_MESSAGE_ID'].set('9')
        self.prepare_answer = self.prepared(**kw)
        response = self.call({'operation': PREPARE, 'arguments': dict(REQUEST)})
        self.sc._VAR_MAP['HERMES_SESSION_MESSAGE_ID'].set('10')
        return response

    def confirm(self):
        return self.call({'operation': CONFIRM, 'arguments': {'draftId': DRAFT}})

    def confirms(self):
        return [c for c in self.transport.call_args_list if c.args[1]['operation'] == CONFIRM]

    def draft_dir(self):
        return self.home / 'mini-apps' / 'drafts' / 'acme'


# ---- 3. dispatch through handle() -------------------------------------------------------------------------------------


class DispatchTest(Base):
    def test_on_a_v1_box_a_generic_op_is_refused_exactly_as_before(self):
        # Fail-before twin: origin/main refuses these with invalid_arguments and sends nothing; so does this head
        # whenever the projection carries no op record (every v1 box).
        with patch.object(mc, 'projected_app', return_value=None):
            for args in ({'operation': PREPARE, 'arguments': dict(REQUEST)}, {'operation': CONFIRM, 'arguments': {'draftId': DRAFT}}):
                response = self.call(args)
                self.assertEqual(response['error'], 'invalid_arguments')
                self.assertNotIn(PREPARE, response['instruction'])
        self.transport.assert_not_called()
        self.daemon.propose.assert_not_called()

    def test_prepare_saves_the_re_derived_card_owner_private(self):
        response = self.prepare()
        self.assertEqual(response['data']['approvalPayload'], CARD)
        call = self.transport.call_args
        self.assertEqual(call.args[1]['operation'], PREPARE)
        self.assertEqual(call.args[1]['arguments'], REQUEST)
        self.assertEqual(call.kwargs, {'operation_class': 'prepare'})
        path = self.draft_dir() / (DRAFT + '.json')
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        record = json.loads(path.read_text())
        self.assertEqual((record['appId'], record['prepare'], record['operation'], record['payload'], record['request']),
                         ('acme', PREPARE, CONFIRM, CARD, REQUEST))

    def test_prepare_without_a_card_declaration_is_undeclared_and_sends_nothing(self):
        del self.app['operations'][1]['card']
        self.assertEqual(self.prepare(), {'error': 'approval_card_undeclared'})
        self.transport.assert_not_called()

    def test_prepare_refuses_a_payload_the_box_does_not_re_derive(self):
        for card, preview in (({**CARD, 'total': '₹1, pay at the jetty'}, None),  # the app's strings differ from its preview
                              (None, {**BASE['preview'], 'request': {**REQUEST, 'kayakId': 'k-9'}}),  # bound to another request
                              (None, {**BASE['preview'], 'note': 'unshown'})):  # a key neither shown nor bound
            with self.subTest(card=card, preview=preview):
                response = self.prepare(card=card, preview=preview)
                self.assertEqual(response['error'], 'approval_card_invalid')
                self.assertNotIn('data', response)
                self.assertFalse((self.draft_dir() / (DRAFT + '.json')).exists())

    def test_prepare_refused_while_the_gate_is_off(self):
        with patch.object(bridge, 'gate_verified', side_effect=ValueError('approval_unavailable')):
            self.assertEqual(self.prepare()['error'], 'approval_unavailable')
        self.transport.assert_not_called()

    def test_confirm_needs_a_later_reply_and_never_proposes_without_a_card(self):
        self.prepare()
        self.sc._VAR_MAP['HERMES_SESSION_MESSAGE_ID'].set('9')
        self.assertEqual(self.confirm()['error'], 'mini_app_confirmation_required')
        self.sc._VAR_MAP['HERMES_SESSION_MESSAGE_ID'].set('10')
        del self.app['operations'][1]['card']
        self.assertEqual(self.confirm(), {'error': 'approval_card_undeclared'})
        self.daemon.propose.assert_not_called()
        self.assertEqual(self.confirms(), [])

    def test_confirm_proposes_the_member_class_and_starts_only_with_a_grant(self):
        self.prepare()
        self.daemon.state = 'granted'
        response = self.confirm()
        self.assertEqual(response['data']['receipt'], RECEIPT)
        cls, key, summary, held = self.daemon.propose.call_args.args
        self.assertEqual((cls, key), (CLASS, KEY))
        self.assertEqual(summary, BASE['summary'])
        self.assertEqual(held, fk.canonical(CARD))
        self.daemon.start.assert_called_once_with(TASK, KEY, held)
        [call] = self.confirms()
        self.assertEqual(call.args[1], {'operation': CONFIRM, 'arguments': {'draftId': DRAFT},
                                        'approval': {'taskId': TASK, 'payloadHash': hashed(CARD), 'payload': CARD}})
        self.assertEqual(call.kwargs, {'operation_class': 'needs-card'})
        self.assertEqual(mg.placed(self.home, 'acme', DRAFT), {'by': 'agent', 'receipt': RECEIPT})
        # A retry answers the recorded receipt and calls nothing.
        self.daemon.propose.reset_mock()
        self.assertEqual(self.confirm()['data']['receipt'], RECEIPT)
        self.daemon.propose.assert_not_called()
        self.assertEqual(len(self.confirms()), 1)

    def test_autonomous_member_class_is_refused_unpinned_and_nothing_runs(self):
        # MUTANT "propose on autonomous accepted" is killed here.
        self.prepare()
        self.daemon.decision = 'autonomous'
        response = self.confirm()
        self.assertEqual(response['error'], 'approval_card_unpinned')
        self.assertEqual(response['instruction'], mc.ACTION_UNPINNED)
        self.daemon.wait.assert_not_called(); self.daemon.start.assert_not_called()
        self.assertEqual(self.confirms(), [])

    def test_other_decisions_and_a_bad_hash_are_refused(self):
        self.prepare()
        for decision in ('supervised', None, 'denied'):
            with self.subTest(decision=decision):
                self.daemon.decision = decision
                self.assertEqual(self.confirm(), {'error': 'approval_refused'})
        self.daemon.decision = 'requested'
        self.daemon.propose.side_effect = lambda *a: answer(0, ok=True, task=TASK, decision='requested', payload_hash='0' * 64)
        self.assertEqual(self.confirm(), {'error': 'approval_refused'})
        self.daemon.start.assert_not_called()
        self.assertEqual(self.confirms(), [])

    def test_start_without_grant_is_refused(self):
        # MUTANT "start without grant" is killed here.
        self.prepare()
        self.daemon.state, self.daemon.authorization = 'granted', 'policy'
        self.assertEqual(self.confirm(), {'error': 'approval_not_started'})
        self.assertEqual(self.confirms(), [])

    def test_untapped_card_is_tracked_for_the_pass(self):
        self.prepare()
        response = self.confirm()
        self.assertEqual(response, {'error': 'approval_required', 'instruction': mc.ACTION_PLACED_ON_APPROVAL})
        marker = json.loads((self.draft_dir() / (DRAFT + '.await')).read_text())
        self.assertEqual((marker['task'], marker['appId'], marker['operation'], marker['phase']), (TASK, 'acme', CONFIRM, 'awaiting'))
        self.daemon.start.assert_not_called()
        with patch.object(bridge, '_ensure_mini_app_pass', return_value=False):
            (self.draft_dir() / (DRAFT + '.await')).unlink()
            self.assertEqual(self.confirm()['instruction'], mc.ACTION_APPROVE_IN_BOT)
            self.assertFalse((self.draft_dir() / (DRAFT + '.await')).exists())

    def test_executed_replay_reuses_the_proof(self):
        self.prepare()
        self.daemon.state = 'started'
        self.assertEqual(self.confirm()['data']['receipt'], RECEIPT)
        self.daemon.wait.assert_not_called(); self.daemon.start.assert_not_called()

    def test_uninstalled_or_changed_card_between_grant_and_call_sends_nothing(self):
        self.prepare()
        self.daemon.state = 'granted'
        real = mc.projected_operation
        calls = []

        def flip(home, op):
            calls.append(op)
            return real(home, op) if len(calls) == 1 else None
        with patch.object(bridge._mini_app_card, 'projected_operation', side_effect=flip):
            self.assertEqual(self.confirm(), {'error': 'mini_app_not_installed'})
        self.assertEqual(self.confirms(), [])

    def test_app_refusals_carry_the_code_and_the_plugin_words_only(self):
        self.prepare()
        self.daemon.state = 'granted'
        self.transport.side_effect = lambda config, payload, **kw: (
            self.prepare_answer if payload['operation'] == PREPARE else {'error': 'mini_app_confirm_in_progress', 'status': 409})
        self.assertEqual(self.confirm(), {'error': 'mini_app_confirm_in_progress', 'instruction': mc.ACTION_CONFIRM_IN_PROGRESS, 'retryable': True})
        self.daemon.state = 'started'
        self.transport.side_effect = lambda config, payload, **kw: {'error': 'Upstream <b>TEXT</b>', 'detail': 'PRIVATE'}
        response = self.confirm()
        self.assertEqual(response, {'error': 'village_unavailable', 'instruction': mc.ACTION_UNCLEAR})


# ---- 4. the draft cache -----------------------------------------------------------------------------------------------


class CacheTest(Base):
    def saved(self):
        self.prepare()
        return self.draft_dir() / (DRAFT + '.json')

    def test_owner_origin_and_hash_are_checked(self):
        path = self.saved()
        entry = self.app['operations'][1]
        config = json.loads((self.home / 'village-bridge.json').read_text())
        self.assertEqual(mc.load_preview(self.home, 'acme', DRAFT, config, entry)['payload'], CARD)
        for bad in ({**config, 'ownerTelegramId': '43'}, {**config, 'origin': 'https://other.example'}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                mc.load_preview(self.home, 'acme', DRAFT, bad, entry)
        record = json.loads(path.read_text())
        for field, value in (('payload', {**CARD, 'total': '₹1'}), ('payloadHash', '0' * 64),
                             ('preview', {**record['preview'], 'sharedWith': 'Your display name: Other'}),
                             ('request', {**REQUEST, 'kayakId': 'k-9'}), ('operation', 'acme.other.confirm'), ('appId', 'other')):
            with self.subTest(field=field):
                path.write_text(json.dumps({**record, field: value}))
                with self.assertRaises(ValueError):
                    mc.load_preview(self.home, 'acme', DRAFT, config, entry)
        path.write_text(json.dumps(record))
        with self.assertRaises(ValueError):  # a different needs-card op cannot load this draft
            mc.load_preview(self.home, 'acme', DRAFT, config, {**entry, 'name': 'acme.other.confirm'})

    def test_links_are_refused(self):
        path = self.saved()
        config = json.loads((self.home / 'village-bridge.json').read_text())
        entry = self.app['operations'][1]
        target = self.home / 'elsewhere.json'; target.write_text(path.read_text())
        path.unlink(); path.symlink_to(target)
        with self.assertRaises(Exception):
            mc.load_preview(self.home, 'acme', DRAFT, config, entry)
        path.unlink()
        moved = self.home / 'moved'; self.draft_dir().rename(moved); self.draft_dir().symlink_to(moved)
        with self.assertRaisesRegex(ValueError, 'approval_preview_unavailable'):
            mc.cache_path(self.home, 'acme', DRAFT)

    def test_first_preview_is_immutable_and_ids_are_checked(self):
        path = self.saved()
        before = path.read_bytes()
        changed = {**CARD, 'when': 'Sun 25 Oct 2026, 07:00 · North jetty'}
        self.prepare_answer = self.prepared(card=changed, preview={**BASE['preview'], 'slot': {'text': changed['when']}})
        self.sc._VAR_MAP['HERMES_SESSION_MESSAGE_ID'].set('11')
        self.assertEqual(self.call({'operation': PREPARE, 'arguments': dict(REQUEST)})['error'], 'approval_preview_unavailable')
        self.assertEqual(path.read_bytes(), before)
        for app_id, draft in (('forkicks', DRAFT), ('gold-stars', DRAFT), ('Acme', DRAFT), ('acme', '../x'), ('acme', 'a' * 101)):
            with self.subTest(app_id=app_id, draft=draft), self.assertRaises(ValueError):
                mc.cache_path(self.home, app_id, draft)


def fixture_config(test):
    return json.loads((test.home / 'village-bridge.json').read_text())


# ---- 5. the on-grant pass (close the loop) -----------------------------------------------------------------------------


class OnGrantTest(Base):
    def ask(self):
        self.prepare()
        response = self.confirm()
        self.assertEqual(response['instruction'], mc.ACTION_PLACED_ON_APPROVAL)
        self.daemon.wait.reset_mock(); self.daemon.propose.reset_mock(); self.transport.reset_mock()
        return response

    def run_pass(self, now=None):
        return mg.run_pass(self.home, fixture_config(self), self.transport, mc.projected_operation, now=now)

    def marker(self, suffix='.await'):
        return self.draft_dir() / (DRAFT + suffix)

    def test_granted_confirms_once_and_the_line_is_delivered_once(self):
        self.ask()
        self.assertEqual(self.run_pass(), {'pending': 1})
        self.daemon.state = 'granted'
        self.assertEqual(self.run_pass(), {'placed:on_grant:line_sent': 1})
        self.assertEqual(len(self.confirms()), 1)
        self.assertEqual(self.confirms()[0].kwargs, {'operation_class': 'needs-card'})
        self.assertEqual(self.sent, [('42', 'Approved: your Acme Kayaks action is placed: Kayak k-2 booked, 2 hours.')])
        self.assertEqual(self.events, [{'outcome': 'placed', 'code': 'on_grant'}])
        self.assertFalse(self.marker().exists())
        self.assertEqual(self.run_pass(), {})
        # The agent's later confirm answers the pass's receipt and calls nothing.
        self.assertEqual(self.confirm()['data']['receipt'], RECEIPT)
        self.assertEqual(len(self.confirms()), 1); self.assertEqual(len(self.sent), 1)
        self.daemon.propose.assert_not_called()  # the pass never proposes

    def test_the_line_has_no_agent_or_preview_text(self):
        # MUTANT "model text in the line" is killed here: only the projection's name and receipt.summary reach it.
        self.ask()
        self.daemon.state = 'granted'
        receipts = iter([{'id': 'rental-78'}])
        self.transport.side_effect = lambda config, payload, **kw: {'receipt': next(receipts)}
        self.run_pass()
        self.assertEqual(self.sent, [('42', 'Approved: your Acme Kayaks action is placed.')])
        for text in (*CARD.values(), *map(str, REQUEST.values()), 'Sunbird', 'kayak'):
            self.assertNotIn(text, self.sent[0][1])

    def test_receipt_summary_is_cleaned_or_dropped(self):
        self.assertEqual(mg.placed_line('Acme', {'id': 'x', 'summary': '**Booked** k-2 <b>!</b>'}), 'Approved: your Acme action is placed: Booked k-2 b/b.')
        self.assertNotIn('MEDIA:', mg.placed_line('Acme', {'id': 'x', 'summary': 'MEDIA:/etc/passwd'}))  # the directive's colon never survives
        self.assertEqual(mg.placed_line('Acme', {'id': 'x', 'summary': '\u202e\n'}), 'Approved: your Acme action is placed.')
        self.assertEqual(mg.placed_line('Acme', {'id': 'x', 'summary': 'y' * 121}), 'Approved: your Acme action is placed.')
        self.assertEqual(mg.placed_line('Acme', {'id': 'x', 'summary': 'y' * 120}), 'Approved: your Acme action is placed: ' + 'y' * 120 + '.')

    def test_agent_placed_first_means_no_second_line_and_no_overwrite(self):
        # MUTANT "receipt not O_EXCL (double place)" is killed here.
        self.ask()
        self.assertTrue(mg.record_placed(self.home, 'acme', DRAFT, RECEIPT, 'agent'))
        self.assertFalse(mg.record_placed(self.home, 'acme', DRAFT, {'id': 'rental-99'}, 'pass'))
        self.daemon.state = 'granted'
        self.assertEqual(self.run_pass(), {'placed:agent_retry': 1})
        self.assertEqual(self.sent, [])
        self.assertEqual(self.confirms(), [])
        self.assertEqual(mg.placed(self.home, 'acme', DRAFT), {'by': 'agent', 'receipt': RECEIPT})

    def test_denied_withdrawn_and_expired_send_the_not_placed_line(self):
        for state, code, reason in (('rejected', 'denied:rejected', 'the approval was declined'),
                                    ('withdrawn', 'denied:withdrawn', 'the approval request was withdrawn'),
                                    ('expired', 'expired:expired', 'the approval or the draft expired'),
                                    ('void', 'expired:void', 'the approval or the draft expired')):
            with self.subTest(state=state):
                for path in self.draft_dir().glob('*') if self.draft_dir().exists() else ():
                    path.unlink()
                self.sent.clear(); self.daemon.state = 'requested'
                self.ask()
                self.daemon.state = state
                self.assertEqual(self.run_pass(), {code + ':line_sent': 1})
                self.assertEqual(self.sent, [('42', f"Your Acme Kayaks action wasn't placed: {reason}.")])
                self.assertEqual(self.confirms(), [])
                self.daemon.start.assert_not_called()
                self.assertFalse(self.marker().exists())

    def test_ttl_and_draft_expiry(self):
        self.ask()
        self.assertEqual(self.run_pass(now=time.time() + mg.TTL_S + 60), {'expired:ttl:line_sent': 1})
        self.assertEqual(self.confirms(), [])
        for path in self.draft_dir().glob('*'):
            path.unlink()
        self.sent.clear()
        self.prepare(expires='2000-01-01T00:00:00+00:00')
        self.confirm()
        self.daemon.state = 'granted'
        self.assertEqual(self.run_pass(), {'expired:draft_expired:line_sent': 1})
        self.daemon.start.assert_not_called()

    def test_invalid_markers_are_dropped_without_a_line(self):
        self.ask()
        record = json.loads(self.marker().read_text())
        for bad in ({**record, 'appId': 'other'}, {**record, 'operation': 'other.rental.confirm'}, {**record, 'task': 'x'},
                    {**record, 'since': '1'}, {**record, 'phase': 'done'}):
            with self.subTest(bad=bad):
                self.marker().write_text(json.dumps(bad))
                self.assertEqual(self.run_pass(), {'marker_invalid': 1})
                self.assertFalse(self.marker().exists())
        self.assertEqual(self.sent, [])
        self.assertEqual(self.confirms(), [])

    def test_start_refused_and_lease_and_unverified(self):
        self.ask()
        self.daemon.state, self.daemon.authorization = 'granted', 'policy'
        self.assertEqual(self.run_pass(), {'start_refused': 1})
        self.assertEqual(self.confirms(), [])
        self.assertTrue(self.marker().exists())
        self.daemon.authorization = 'grant'
        self.transport.side_effect = lambda config, payload, **kw: {'error': 'mini_app_confirm_in_progress', 'status': 409}
        self.assertEqual(self.run_pass(), {'confirm_in_progress': 1})
        self.transport.side_effect = lambda config, payload, **kw: {'error': 'mini_app_approval_required', 'status': 403}
        self.assertEqual(self.run_pass(), {'approval_not_verified': 1})
        self.assertEqual(self.run_pass(), {'approval_not_verified': 1})
        self.assertEqual(self.run_pass(), {'failed:approval_not_verified:line_sent': 1})
        self.assertEqual(self.sent, [('42', "Your Acme Kayaks action wasn't placed: the app couldn't take it.")])

    def test_uncertain_answers_retry_the_same_draft_and_line_once(self):
        self.ask()
        self.daemon.state = 'granted'
        answers = iter([{'error': 'connection_or_request_refused', 'status': 502}, {'draftId': DRAFT}, {'receipt': dict(RECEIPT)}])
        self.transport.side_effect = lambda config, payload, **kw: next(answers)
        self.assertEqual(self.run_pass(), {'confirm_uncertain': 1})
        self.assertEqual(json.loads(self.marker().read_text())['phase'], 'attempted')
        self.assertEqual(self.run_pass(), {'confirm_uncertain': 1})  # a 2xx without a receipt: lease kept, retried
        self.assertEqual(self.run_pass(), {'placed:on_grant:line_sent': 1})
        self.assertEqual({c.args[1]['arguments']['draftId'] for c in self.confirms()}, {DRAFT})
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(self.daemon.start.call_count, 1)

    def test_a_definite_refusal_is_not_placed(self):
        self.ask()
        self.daemon.state = 'granted'
        self.transport.side_effect = lambda config, payload, **kw: {'error': 'mini_app_draft_rejected', 'status': 409}
        self.assertEqual(self.run_pass(), {'failed:refused_409:line_sent': 1})

    def test_not_projected_waits_then_closes(self):
        self.ask()
        self.app = {'id': 'acme', 'operations': []}
        self.assertEqual(self.run_pass(), {'not_installed': 1})
        self.assertTrue(self.marker().exists())
        self.assertEqual(self.run_pass(now=time.time() + mg.TTL_S + 60), {'failed:not_installed:line_sent': 1})
        self.assertEqual(self.sent, [('42', "Your mini-app action wasn't placed: the app couldn't take it.")])
        self.daemon.wait.assert_not_called()


# ---- 6. adaptive polling ------------------------------------------------------------------------------------------------


class AdaptivePollingTest(Base):
    def test_busy_while_a_marker_is_younger_than_its_ttl(self):
        self.assertFalse(mg.busy(self.home))
        self.prepare(); self.confirm()
        now = time.time()
        self.assertTrue(mg.busy(self.home, now=now))
        self.assertFalse(mg.busy(self.home, now=now + mg.TTL_S + 1))
        # For Kicks' markers through the same probe.
        folder = self.home / 'forkicks-drafts'; folder.mkdir()
        self.assertFalse(mg.young_marker([folder], fkg.TTL_S))
        (folder / 'd1.await').write_text(json.dumps({'task': TASK, 'since': int(now), 'phase': 'awaiting'}))
        self.assertTrue(mg.young_marker([folder], fkg.TTL_S, now=now))
        self.assertFalse(mg.young_marker([folder], fkg.TTL_S, now=now + fkg.TTL_S + 1))
        (folder / 'd1.await').write_text('not json')
        self.assertFalse(mg.young_marker([folder], fkg.TTL_S, now=now))

    def test_both_passes_register_their_busy_probe(self):
        ap = types.SimpleNamespace(register_pass=Mock(), register_busy=Mock(), ensure_poller=Mock(return_value=True),
                                   configured=lambda: True, POLLER_ENV='AV_APPROVAL_POLLER', process_env=lambda name: '')
        with patch.dict(sys.modules, {'hermes_plugins.av_events._approval': ap}):
            self.assertTrue(bridge._ensure_forkicks_pass())
            names = {c.args[0] for c in ap.register_busy.call_args_list}
            self.assertEqual(names, {fkg.PASS_NAME, mg.PASS_NAME})
            probes = {c.args[0]: c.args[1] for c in ap.register_busy.call_args_list}
            self.assertFalse(probes[mg.PASS_NAME]())
            self.prepare(); self.confirm()
            self.assertTrue(probes[mg.PASS_NAME]())
            self.assertFalse(probes[fkg.PASS_NAME]())
        with patch.dict(sys.modules, {'hermes_plugins.av_events._approval': ap}), \
                patch.object(bridge, '_ensure_mini_app_pass', ENSURE_MINI):
            ap.register_pass.reset_mock()
            self.assertTrue(bridge._ensure_mini_app_pass())
            ap.register_pass.assert_called_with(mg.PASS_NAME, bridge._mini_app_grant_pass)
            with patch.dict(os.environ, {'AV_APPROVAL_POLLER': 'off'}):
                ap.process_env = lambda name: os.environ.get(name, '')
                ap.register_pass.reset_mock()
                self.assertFalse(bridge._ensure_mini_app_pass())
                ap.register_pass.assert_not_called()

    def test_an_older_av_events_without_register_busy_keeps_working(self):
        ap = types.SimpleNamespace(register_pass=Mock(), ensure_poller=Mock(return_value=True), configured=lambda: True,
                                   POLLER_ENV='AV_APPROVAL_POLLER', process_env=lambda name: '')
        with patch.dict(sys.modules, {'hermes_plugins.av_events._approval': ap}):
            self.assertTrue(bridge._ensure_forkicks_pass())
        ap.register_pass.assert_called_with(fkg.PASS_NAME, bridge._forkicks_grant_pass)


ENSURE_MINI = bridge._ensure_mini_app_pass  # the real one, captured before any setUp patches it


# ---- 7. transport for a generic op -------------------------------------------------------------------------------------


class GenericTransportTest(unittest.TestCase):
    CONFIG = {'origin': 'https://agents.edgecity.live', 'token': 'not-logged'}

    def opener(self, body=b'{}'):
        response = unittest.mock.MagicMock(); response.__enter__.return_value = response; response.read.return_value = body
        opener = Mock(); opener.open.return_value = response
        return opener

    def test_header_timeout_and_duplicate_keys(self):
        for cls, timeout in (('prepare', 25), ('needs-card', 60)):
            opener = self.opener()
            with patch.object(bridge, 'build_opener', return_value=opener):
                fixture.real_transport(self.CONFIG, {'operation': CONFIRM, 'arguments': {}}, operation_class=cls)
            request = opener.open.call_args.args[0]
            self.assertEqual(request.get_header('X-village-operation'), CONFIRM)
            self.assertEqual(opener.open.call_args.kwargs['timeout'], timeout)
        with patch.object(bridge, 'build_opener', return_value=self.opener(b'{"receipt":{"id":"a"},"receipt":{"id":"b"}}')):
            with self.assertRaises(ValueError):
                fixture.real_transport(self.CONFIG, {'operation': CONFIRM}, operation_class='needs-card')
        with self.assertRaisesRegex(ValueError, 'request_too_large'):
            fixture.real_transport(self.CONFIG, {'operation': CONFIRM, 'arguments': {'x': 'y' * 70000}}, operation_class='prepare')

    def test_refusals_forward_the_code_only(self):
        import io
        from urllib.error import HTTPError
        for body, status, expected in ((b'{"code":"mini_app_confirm_in_progress","detail":"PRIVATE"}', 409, 'mini_app_confirm_in_progress'),
                                       (b'{"code":"Bad Code","detail":"PRIVATE"}', 403, 'connection_or_request_refused'),
                                       (b'not json PRIVATE', 500, 'connection_or_request_refused')):
            opener = Mock()
            opener.open.side_effect = HTTPError('https://agents.edgecity.live/api/v1/village-bridge/tool', status, 'refused', {}, io.BytesIO(body))
            with patch.object(bridge, 'build_opener', return_value=opener):
                result = fixture.real_transport(self.CONFIG, {'operation': CONFIRM}, operation_class='needs-card')
            self.assertEqual(result, {'error': expected, 'status': status})
            self.assertNotIn('PRIVATE', json.dumps(result))


if __name__ == '__main__':
    unittest.main()
