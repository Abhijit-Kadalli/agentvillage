"""Review-a RA41 folds for ov#459 (lead L20080): S1 one live order per owner, S2 a closed card says "nothing was
ordered", S3 the spent-grant adoption branch pinned (review-a's probes, copied from
lanes-review-a/ra41-probes/test_ra41_probes.py), N5 the For Kicks fast poll. Offline: a fake multi-task daemon
(core's key/bytes binding), a fake app, no network, no Telegram."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

fixture = sys.modules.get('village_bridge_test_fixture')
if fixture is None:
    _spec = importlib.util.spec_from_file_location('village_bridge_test_fixture', Path(__file__).with_name('test_bridge.py'))
    fixture = importlib.util.module_from_spec(_spec)
    sys.modules[_spec.name] = fixture
    _spec.loader.exec_module(fixture)
on_grant = sys.modules.get('village_bridge_test_forkicks_grant')
if on_grant is None:
    _spec = importlib.util.spec_from_file_location('village_bridge_test_forkicks_grant', Path(__file__).with_name('test_forkicks_grant.py'))
    on_grant = importlib.util.module_from_spec(_spec)
    sys.modules[_spec.name] = on_grant
    _spec.loader.exec_module(on_grant)
bridge, mini = fixture.bridge, fixture.mini
fk = sys.modules['village_bridge._forkicks']
grant = sys.modules['village_bridge._forkicks_grant']
answer = on_grant.answer

D1 = '550e8400-e29b-41d4-a716-446655440001'
D2 = '550e8400-e29b-41d4-a716-446655440002'
PREFIX = 'marketplace.app.action:forkicks.order.confirm:'
PLACED_PREFIX = 'Approved: your For Kicks order is placed'


class MultiDaemon:
    """approval.md as the box sees it, one task per key, core binding the start to the task's own key + bytes."""

    def __init__(self):
        self.tasks = {}  # task -> {key, hash, state}
        self.propose = Mock(side_effect=self._propose)
        self.wait = Mock(side_effect=self._wait)
        self.start = Mock(side_effect=self._start)
        self.withdraw = Mock(side_effect=self._withdraw)
        self.raise_after_record = False

    def task_of(self, key):
        return 'propose:' + hashlib.md5(key.encode()).hexdigest()

    def _propose(self, cls, key, summary, payload):
        task = self.task_of(key)
        h = hashlib.sha256(payload.encode()).hexdigest()
        t = self.tasks.setdefault(task, {'key': key, 'hash': h, 'state': 'requested'})
        if self.raise_after_record:
            raise RuntimeError('timeout')  # the daemon recorded (and sent) the card; the box lost the answer
        return answer(0, ok=True, task=task, decision='requested', payload_hash=t['hash'],
                      state='executed' if t['state'] == 'started' else None)

    def _wait(self, task):
        t = self.tasks.get(task)
        if t is None:
            return answer(1, ok=True, task=task, status='not-registered')
        s = t['state']
        if s == 'requested':
            return answer(6, ok=False, task=task, status='requested')
        if s == 'granted':
            return answer(0, ok=True, task=task, status='granted', actions=[{'action_key': t['key'], 'state': 'granted'}])
        if s == 'started':
            return answer(0, ok=True, task=task, status='nothing-to-wait-for', actions=[{'action_key': t['key'], 'state': 'granted'}])
        code = {'rejected': 1, 'withdrawn': 1, 'expired': 3, 'void': 7}[s]
        return answer(code, ok=True, task=task, status=s, actions=[{'action_key': t['key'], 'state': s}])

    def _start(self, task, key, held):
        t = self.tasks.get(task)
        if t is None or t['state'] != 'granted' or t['key'] != key or hashlib.sha256(held.encode()).hexdigest() != t['hash']:
            return answer(1, ok=False, error={'code': 'not-granted'})
        t['state'] = 'started'
        return answer(0, ok=True, task=task, action_key=key, authorization='grant')

    def _withdraw(self, task, reason):
        t = self.tasks.get(task)
        if t is not None and t['state'] == 'requested':
            t['state'] = 'withdrawn'
        return answer(0, ok=True, task=task, status='withdrawn')

    def tap(self, draft, state='granted'):
        self.tasks[self.task_of(PREFIX + draft)]['state'] = state


class MultiApp:
    def __init__(self, test):
        self.test, self.orders, self.prepares = test, {}, []

    def __call__(self, config, payload, **kw):
        if payload['operation'] == 'forkicks.order.prepare':
            return self.test.next_prepare
        draft = payload['draftId']
        self.orders[draft] = 1  # merchant-idempotent per draft
        return {'orderId': 'order-' + draft[-4:], 'number': '#0' + draft[-2:], 'status': 'queued'}


class MultiApp:
    def __init__(self, test):
        self.test, self.orders = test, {}

    def __call__(self, config, payload, **kw):
        if payload['operation'] == 'forkicks.order.prepare':
            return self.test.next_prepare
        draft = payload['draftId']
        self.orders[draft] = self.orders.get(draft, 0) + 1
        return {'orderId': 'order-' + draft[-4:], 'number': '#0' + draft[-2:], 'status': 'queued'}


class SupersedeTest(unittest.TestCase):
    setUp_bridge = fixture.BridgeTest.setUp
    call = fixture.BridgeTest.call
    preview = on_grant.ForKicksOnGrantTest.preview

    def setUp(self):
        self.setUp_bridge()
        self.home = Path(self.tmp.name)
        (self.home / 'mini-apps.json').write_text(json.dumps({'version': 1, 'apps': [{'id': 'forkicks', **mini.FORKICKS}]}))
        for name, value in (('_ensure_forkicks_pass', True), ('gate_verified', None)):
            p = patch.object(bridge, name, return_value=value); p.start(); self.addCleanup(p.stop)
        self.daemon = MultiDaemon()
        for module in (fk, grant):
            p = patch.object(module, 'approval_modules', return_value=self.daemon); p.start(); self.addCleanup(p.stop)
        self.sent = []
        p = patch.object(grant, '_telegram_dm', side_effect=lambda owner, text: self.sent.append((owner, text)) or True)
        p.start(); self.addCleanup(p.stop)
        self.app = MultiApp(self)
        self.transport.side_effect = self.app
        self.sc._VAR_MAP['HERMES_SESSION_MESSAGE_ID'].set('9')

    def prepare(self, draft, qty=2):
        self.next_prepare, order = self.preview(draft=draft)
        if qty != 2:
            pv = self.next_prepare['approvalPayload']['preview']
            pv['items'][0]['qty'] = qty
            pv['quote']['lines'][0].update(qty=qty, lineInr=190 * qty)
            pv['quote']['totalInr'] = 190 * qty
            self.next_prepare['payloadHash'] = hashlib.sha256(fk.canonical(self.next_prepare['approvalPayload']).encode()).hexdigest()
        return self.call({'operation': 'forkicks.order.prepare', **order})

    def confirm(self, draft):
        return self.call({'operation': 'forkicks.order.confirm', 'draftId': draft})

    def run_pass(self):
        bridge._forkicks_grant_pass()

    def placed_lines(self):
        return [text for _, text in self.sent if text.startswith(PLACED_PREFIX)]

    # ---- S1: one live order per owner ----------------------------------------------------------------

    def test_changed_order_two_taps_place_exactly_one_order_the_newest(self):
        self.assertEqual(self.prepare(D1)['approval'], 'requested')
        self.assertEqual(self.prepare(D2, qty=3)['approval'], 'requested')
        # At D2's prepare (after D2's card went out), D1's waiting card was withdrawn.
        self.daemon.withdraw.assert_called_once_with(self.daemon.task_of(PREFIX + D1), 'superseded')
        self.assertEqual(self.daemon.propose.call_args_list[-1].args[1], PREFIX + D2)  # D2's propose came first
        # The resident taps BOTH cards (core refusing nothing here: the box's own check must hold).
        self.daemon.tap(D1); self.daemon.tap(D2)
        self.run_pass(); self.run_pass()
        self.assertEqual(self.app.orders, {D2: 1})  # exactly one order, the newest
        self.assertEqual(len(self.placed_lines()), 1)
        self.assertEqual([t for _, t in self.sent if not t.startswith(PLACED_PREFIX)], [grant.SUPERSEDED_LINE])
        self.assertTrue(grant.SUPERSEDED_LINE.startswith('Nothing was ordered'))
        self.assertEqual({owner for owner, _ in self.sent}, {'42'})
        self.assertFalse((self.home / 'forkicks-drafts' / (D1 + '.await')).exists())

    def test_the_pass_refuses_an_older_draft_even_when_the_withdraw_never_reached_the_daemon(self):
        self.prepare(D1)
        self.daemon.withdraw.side_effect = RuntimeError('timeout')
        self.prepare(D2, qty=3)
        self.daemon.tap(D1)  # the old card was never withdrawn, and the resident taps it
        self.run_pass()
        self.daemon.start.assert_not_called()
        self.assertEqual(self.app.orders, {})
        self.assertEqual(self.sent, [('42', grant.SUPERSEDED_LINE)])
        self.daemon.tap(D2)
        self.run_pass()
        self.assertEqual(self.app.orders, {D2: 1})

    def test_a_started_older_draft_is_not_abandoned(self):
        # Belt and braces applies only before a start: a draft whose grant was already started keeps its confirm.
        self.prepare(D1)
        self.daemon.tap(D1)
        marker = self.home / 'forkicks-drafts' / (D1 + '.await')
        doc = json.loads(marker.read_text()); doc['phase'] = 'started'; marker.write_text(json.dumps(doc))
        self.daemon.tasks[self.daemon.task_of(PREFIX + D1)]['state'] = 'started'
        grant.set_latest(self.home, D2)
        self.run_pass()
        self.assertEqual(self.app.orders, {D1: 1})

    # ---- S2: a closed card ----------------------------------------------------------------------------

    def test_a_closed_card_read_at_confirm_says_nothing_was_ordered(self):
        self.prepare(D1)
        for state in ('expired', 'rejected', 'withdrawn', 'void'):
            with self.subTest(state=state):
                self.daemon.tap(D1, state)
                response = self.confirm(D1)
                self.assertEqual(response, {'error': 'approval_card_closed', 'instruction': mini.ORDER_CARD_CLOSED})
                self.assertIn('"Nothing was ordered. Ask me for a new preview."', response['instruction'])
                self.assertNotIn('approve', response['instruction'].lower().replace('approval card', ''))
        self.assertEqual(self.daemon.propose.call_count, 1)
        self.daemon.start.assert_not_called()
        self.assertEqual(self.app.orders, {})

    # ---- S3: the spent-grant adoption branch (review-a RA41 probes, copied) ---------------------------

    def test_forged_card_marker_with_another_drafts_granted_task_never_places(self):
        """Agent shell writes D2.card = D1's (granted) task: core's key binding + the box's action_key filter hold."""
        self.prepare(D1); self.prepare(D2, qty=3)
        self.daemon.tap(D1)
        t1 = self.daemon.task_of(PREFIX + D1)
        card = self.home / 'forkicks-drafts' / (D2 + '.card')
        card.unlink(); card.write_text(json.dumps({'task': t1}))
        self.assertIn('error', self.confirm(D2))
        self.assertNotIn(D2, self.app.orders)
        # and once D1's grant is spent (nothing-to-wait-for, D1's action granted): the adoption branch must not adopt it
        self.daemon.tasks[t1]['state'] = 'started'
        self.assertIn('error', self.confirm(D2))
        self.assertNotIn(D2, self.app.orders)

    def test_adoption_needs_exit0_and_this_drafts_action_granted(self):
        """Kills R2/R3: a spent-grant read is adopted only with exit 0 AND this draft's own action `granted`."""
        self.prepare(D1)
        t1 = self.daemon.task_of(PREFIX + D1)
        for code, state in ((0, 'rejected'), (0, 'withdrawn'), (1, 'granted'), (3, 'granted')):
            with self.subTest(code=code, state=state):
                self.daemon.wait.side_effect = lambda task, code=code, state=state: answer(
                    code, ok=True, task=task, status='nothing-to-wait-for', actions=[{'action_key': PREFIX + D1, 'state': state}])
                self.assertIn('error', self.confirm(D1))
                self.assertEqual(self.app.orders, {})
        self.daemon.start.assert_not_called()

    # ---- N5: the For Kicks fast poll ---------------------------------------------------------------------

    def test_fast_poll_wakes_the_poller_every_2_s_only_while_a_card_awaits(self):
        ap = Mock(); ap.poller_alive.return_value = True
        sleeps = []
        bridge._forkicks_tick(self.home, ap, sleep=sleeps.append)  # no marker: no sleep, no work
        self.assertEqual((sleeps, ap.kick.call_count), ([], 0))
        self.prepare(D1)
        marker = self.home / 'forkicks-drafts' / (D1 + '.await')
        self.assertTrue(marker.exists())

        def sleep(seconds):
            sleeps.append(seconds)
            if len(sleeps) == 3:
                marker.unlink()  # the pass closed it (placed / denied / expired)

        bridge._forkicks_tick(self.home, ap, sleep=sleep)
        self.assertEqual(sleeps, [2.0, 2.0, 2.0])
        self.assertEqual(ap.kick.call_count, 3)
        self.assertLess(bridge._forkicks_poll_s() + 1.0, 5.0)  # one interval + a pass stays under Carter's 5 s
        for raw, expected in (('0.2', 1.0), ('3', 3.0), ('nan', 2.0), ('x', 2.0), ('900', 30.0), ('', 2.0)):
            with patch.dict(os.environ, {'AV_FORKICKS_POLL_S': raw}):
                self.assertEqual(bridge._forkicks_poll_s(), expected)
        ap.poller_alive.return_value = False  # no poller: no kick (never a one-shot pass every 2 s)
        self.prepare(D2, qty=3)
        marker = self.home / 'forkicks-drafts' / (D2 + '.await')
        sleeps.clear()
        bridge._forkicks_tick(self.home, ap, sleep=lambda s: marker.unlink() if marker.exists() else None)
        self.assertEqual(ap.kick.call_count, 3)

    def test_the_ticker_starts_after_the_card_is_tracked(self):
        with patch.object(bridge, '_ensure_forkicks_ticker') as ticker:
            self.prepare(D1)
        ticker.assert_called_once_with(self.home)
        self.assertTrue((self.home / 'forkicks-drafts' / (D1 + '.await')).exists())


if __name__ == '__main__':
    unittest.main()
