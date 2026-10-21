"""The For Kicks flat order card (Carter P0, 21 Oct; v2.1.10 hotfix): the box accepts the app's legacy payload
{appId, operation, preview} AND the four-key {order, total, pickup, name}, re-derives the four strings from the
order preview the app returned beside the payload at prepare, refuses any difference, and proposes the app's payload
byte for byte under the unchanged class and per-draftId key. Spec + golden vectors: tests/vectors/."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest
import unittest.mock
from unittest.mock import Mock, patch
# pytest.ini's --import-mode=importlib keeps tests/ off sys.path, so load the shared fixture by path (once).
fixture = sys.modules.get('village_bridge_test_fixture')
if fixture is None:
    _spec = importlib.util.spec_from_file_location('village_bridge_test_fixture', Path(__file__).with_name('test_bridge.py'))
    fixture = importlib.util.module_from_spec(_spec)
    sys.modules[_spec.name] = fixture
    _spec.loader.exec_module(fixture)
bridge, mini = fixture.bridge, fixture.mini
fk = sys.modules['village_bridge._forkicks']

VECTORS = json.loads(Path(__file__).with_name('vectors').joinpath('forkicks-approval-card.json').read_text(encoding='utf-8'))
KEY = 'marketplace.app.action:forkicks.order.confirm:'


def answer(**doc):
    return types.SimpleNamespace(ok=doc.get('ok') is True, doc=doc, exit_code=0, status=doc.get('status'))


def vector(name):
    return copy.deepcopy(next(v for v in VECTORS['vectors'] if v['name'].startswith(name)))


def hashed(payload):
    return hashlib.sha256(fk.canonical(payload).encode()).hexdigest()


class GoldenVectorTest(unittest.TestCase):
    def test_every_golden_vector(self):
        self.assertEqual(VECTORS['valueMax'], fk.CARD_VALUE_MAX)
        self.assertGreaterEqual(len(VECTORS['vectors']), 10)
        for v in VECTORS['vectors']:
            with self.subTest(v['name']):
                if 'card' in v:
                    self.assertEqual(fk.card_fields(v['preview']), v['card'])
                else:
                    with self.assertRaisesRegex(ValueError, '^' + v['error'] + '$'):
                        fk.card_fields(v['preview'])

    def test_carter_target_card_text(self):
        self.assertEqual(fk.card_fields(vector('carter-target')['preview']), {
            'order': '1 × Iced latte (Oat milk, Miso caramel syrup)', 'total': '₹0, pay by UPI',
            'pickup': 'For Kicks Mandrem · 21 Oct 2026', 'name': 'Carter'})

    def test_every_line_is_listed_uncut(self):
        p = vector('two lines')['preview']
        self.assertEqual(fk.card_fields(p)['order'], '2 × Cold brew (Oat milk, Large); 1 × Butter croissant')
        p['quote']['lines'] *= 3; p['items'] *= 3
        self.assertEqual(fk.card_fields(p)['order'].count(' × '), 6)

    def test_budget_edge_is_exactly_core_value_max(self):
        self.assertIn('card', vector('exactly 278')); self.assertEqual(len(vector('exactly 278')['card']['order']), 278)
        for n in ('279', '280', '281'):
            self.assertEqual(vector(n + ' code points')['error'], 'approval_card_not_minimal')


class FlatCardBoxTest(unittest.TestCase):
    setUp = fixture.BridgeTest.setUp
    call = fixture.BridgeTest.call

    def enable(self):
        Path(self.tmp.name, 'mini-apps.json').write_text(json.dumps({'version': 1, 'apps': [{'id': 'forkicks', **mini.FORKICKS}]}))
        gate = patch.object(bridge, 'gate_verified', return_value=None); gate.start(); self.addCleanup(gate.stop)

    def app_answer(self, name='carter-target', shape='flat'):
        """The app's prepare answer: a flat payload with the order preview beside it, or today's legacy payload."""
        v = vector(name)
        preview = v['preview']
        payload = v['card'] if shape == 'flat' else {'appId': 'forkicks', 'operation': 'forkicks.order.confirm', 'preview': preview}
        result = {'draftId': preview['draftId'], 'quote': preview['quote'], 'displayName': preview['displayName'],
                  'approvalPayload': payload, 'payloadHash': hashed(payload)}
        if shape == 'flat':
            result['preview'] = preview
        return result

    def args(self, result):
        p = result.get('preview') or result['approvalPayload']['preview']
        return {'operation': 'forkicks.order.prepare', 'items': [{'itemId': 'item-0', 'qty': 1, 'optionIds': []}],
                'fulfilment': {'type': 'pickup', 'locationId': p['fulfilment']['locationId']}, 'paymentMethod': p['paymentMethod']}

    def prepare(self, result, extra=None):
        self.enable()
        self.transport.return_value = result
        response = self.call({**self.args(result), **(extra or {})})
        self.transport.reset_mock()
        self.transport.return_value = {'orderId': 'order-1', 'number': '#042', 'payment': {'simulated': True, 'label': 'Test payment, no money moved'}}
        return response

    def refused(self, result, code):
        """The box's own refusal code, and through the tool: no draft is cached (the tool says village_unavailable)."""
        with self.assertRaisesRegex(ValueError, '^' + code + '$'):
            fk.checked_payload(result.get('approvalPayload'), result['draftId'], result.get('payloadHash'), result.get('preview'))
        self.assertEqual(self.prepare(result)['error'], 'village_unavailable')
        self.assertFalse(self.record_path(result['draftId']).exists())

    def daemon(self, decision='requested'):
        ap = Mock()
        ap.propose.side_effect = lambda cls, key, summary, payload: answer(ok=True, task='propose:' + 'a' * 32, decision=decision, state='granted', payload_hash=hashlib.sha256(payload.encode()).hexdigest())
        ap.wait.return_value = answer(status='granted')
        ap.start.return_value = answer(ok=True, authorization='grant')
        return ap

    def next_turn(self):
        self.sc._VAR_MAP['HERMES_SESSION_MESSAGE_ID'].set('10')

    def record_path(self, draft):
        return Path(self.tmp.name, 'forkicks-drafts', draft + '.json')

    def confirm(self, draft, ap):
        with patch.object(fk, 'approval_modules', return_value=ap):
            return self.call({'operation': 'forkicks.order.confirm', 'draftId': draft})

    def test_flat_payload_is_saved_with_its_preview_and_proposed_byte_for_byte_under_the_same_class_and_key(self):
        result = self.app_answer()
        response = self.prepare(result); self.assertEqual(response.get('data'), result, response)
        record = json.loads(self.record_path(result['draftId']).read_text())
        self.assertEqual(record['payload'], result['approvalPayload']); self.assertEqual(record['preview'], result['preview'])
        self.next_turn(); ap = self.daemon()
        self.assertIn('data', self.confirm(result['draftId'], ap))
        cls, key, summary, held = ap.propose.call_args.args
        self.assertEqual((cls, key), ('marketplace.app.action', KEY + result['draftId']))
        self.assertEqual(held, fk.canonical(result['approvalPayload']))  # the app's payload, exactly
        self.assertEqual(sorted(json.loads(held)), ['name', 'order', 'pickup', 'total'])
        self.assertEqual(summary, fk.approval_summary({'preview': result['preview']}))  # the technical card's text, from the saved order
        sent = self.transport.call_args.args[1]
        self.assertEqual(sent['approval'], {'taskId': 'propose:' + 'a' * 32, 'payloadHash': result['payloadHash'], 'payload': result['approvalPayload']})
        ap.start.assert_called_once_with('propose:' + 'a' * 32, KEY + result['draftId'], held)

    def test_legacy_payload_still_confirms_unchanged(self):
        result = self.app_answer(shape='legacy')
        self.prepare(result)
        self.assertNotIn('preview', json.loads(self.record_path(result['draftId']).read_text()))
        self.next_turn(); ap = self.daemon()
        self.assertIn('data', self.confirm(result['draftId'], ap))
        cls, key, summary, held = ap.propose.call_args.args
        self.assertEqual((cls, key, held), ('marketplace.app.action', KEY + result['draftId'], fk.canonical(result['approvalPayload'])))
        self.assertEqual(summary, fk.approval_summary(result['approvalPayload']))

    def test_flat_strings_that_differ_from_the_saved_order_are_refused_and_never_cached(self):
        for field, value in [('order', '1 × Iced latte'), ('total', '₹0, card at pickup'), ('pickup', 'Elsewhere · 21 Oct 2026'),
                             ('name', 'Someone else'), ('order', '1 × Iced latte (Oat milk, Miso caramel syrup) ')]:
            with self.subTest(field=field):
                result = self.app_answer()
                result['approvalPayload'][field] = value
                result['payloadHash'] = hashed(result['approvalPayload'])  # a consistent hash: only the words differ
                self.refused(result, 'approval_card_invalid')
        result = self.app_answer()
        result['preview']['quote']['totalInr'] = 5  # the order beside the payload says otherwise
        self.refused(result, 'approval_card_invalid')

    def test_flat_payload_needs_its_own_drafts_preview_and_exactly_four_keys(self):
        cases = []
        r = self.app_answer(); del r['preview']; cases.append(r)
        r = self.app_answer(); r['preview']['draftId'] = 'other-draft'; cases.append(r)
        r = self.app_answer(); r['approvalPayload']['appId'] = 'forkicks'; r['payloadHash'] = hashed(r['approvalPayload']); cases.append(r)
        r = self.app_answer(); del r['approvalPayload']['name']; r['payloadHash'] = hashed(r['approvalPayload']); cases.append(r)
        r = self.app_answer(); r['payloadHash'] = 'f' * 64; cases.append(r)
        for result in cases:
            self.refused(result, 'approval_preview_unavailable')

    def test_agent_supplied_order_or_total_never_reaches_the_card(self):
        result = self.app_answer()
        # In the prepare arguments: refused before any request, so nothing is cached.
        for extra in ({'order': '1 × Free latte'}, {'total': '₹0'}, {'order': 'x', 'total': 'y', 'pickup': 'z', 'name': 'w'}):
            self.enable(); self.transport.return_value = result
            out = self.call({**self.args(result), **extra})
            self.assertIn('error', out); self.transport.assert_not_called()
            self.assertFalse(self.record_path(result['draftId']).exists())
        # In the confirm arguments: refused; the proposal is only ever the saved app payload.
        self.prepare(result); self.next_turn(); ap = self.daemon()
        with patch.object(fk, 'approval_modules', return_value=ap):
            out = self.call({'operation': 'forkicks.order.confirm', 'draftId': result['draftId'], 'order': '1 × Free latte', 'total': '₹0'})
        self.assertIn('error', out); ap.propose.assert_not_called(); self.transport.assert_not_called()
        # The saved record edited after prepare (a different order beside the same payload): refused at confirm.
        path = self.record_path(result['draftId'])
        record = json.loads(path.read_text()); record['preview']['quote']['lines'][0]['name'] = 'Free latte'
        path.write_text(json.dumps(record))
        out = self.confirm(result['draftId'], ap)
        self.assertEqual(out['error'], 'approval_preview_unavailable'); ap.propose.assert_not_called()

    def test_an_order_over_the_card_budget_is_never_cut(self):
        long = vector('over the card budget')
        self.assertEqual(long['error'], 'approval_card_not_minimal')
        # The app (by the spec) sends the legacy shape: accepted, every line in the technical card's summary.
        result = self.app_answer('over the card budget', shape='legacy')
        self.prepare(result); self.next_turn(); ap = self.daemon()
        self.assertIn('data', self.confirm(result['draftId'], ap))
        held, summary = ap.propose.call_args.args[3], ap.propose.call_args.args[2]
        self.assertEqual(json.loads(held), result['approvalPayload'])
        for i in range(1, 7):
            self.assertIn(f'Seasonal special number {i}', summary)
        # The 280- and 281-code-point drafts (approval L17750's edge) arrive legacy too and are accepted.
        for n in ('280', '281'):
            result = self.app_answer(n + ' code points', shape='legacy')
            self.sc._VAR_MAP['HERMES_SESSION_MESSAGE_ID'].set('9')
            self.prepare(result); self.next_turn(); ap = self.daemon()
            self.assertIn('data', self.confirm(result['draftId'], ap))
            self.assertEqual(json.loads(ap.propose.call_args.args[3]), result['approvalPayload'])
        # A flat payload carrying the over-budget order uncut is refused, and a cut one is a mismatch.
        p = long['preview']
        lines = '; '.join(f'{l["qty"]} × {l["name"]} ({", ".join(l["options"])})' for l in p['quote']['lines'])
        for order in (lines, lines[:fk.CARD_VALUE_MAX - 1] + '…'):
            payload = {'order': order, 'total': '₹1800, pay by UPI', 'pickup': 'For Kicks Mandrem · 21 Oct 2026', 'name': 'Carter'}
            self.refused({'draftId': p['draftId'], 'approvalPayload': payload, 'payloadHash': hashed(payload), 'preview': p},
                         'approval_card_not_minimal')

    def test_a_note_to_the_cafe_never_rides_a_flat_card_only_the_legacy_technical_one(self):
        # WYSIWYS (security review): the note is agent-written text sent to the café and is not on the four rows.
        v = vector('a note to the cafe')
        self.assertEqual(v['error'], 'approval_card_invalid')
        payload = fk.card_fields({k: x for k, x in v['preview'].items() if k != 'note'})  # what the four rows would say
        self.refused({'draftId': v['preview']['draftId'], 'approvalPayload': payload, 'payloadHash': hashed(payload), 'preview': v['preview']},
                     'approval_card_invalid')
        result = self.app_answer('a note to the cafe', shape='legacy')
        self.prepare(result); self.next_turn(); ap = self.daemon()
        self.assertIn('data', self.confirm(result['draftId'], ap))
        self.assertIn('Note: "No sugar please"', ap.propose.call_args.args[2])  # the technical card shows it
        # The same holds for a preview edited after prepare to carry a note.
        self.sc._VAR_MAP['HERMES_SESSION_MESSAGE_ID'].set('9')
        flat = self.app_answer('an empty note'); self.prepare(flat)
        path = self.record_path(flat['draftId']); record = json.loads(path.read_text()); record['preview']['note'] = 'Also a croissant'
        path.write_text(json.dumps(record)); self.next_turn(); ap = self.daemon()
        self.assertEqual(self.confirm(flat['draftId'], ap)['error'], 'approval_preview_unavailable'); ap.propose.assert_not_called()

    def test_every_unshown_order_field_refuses_the_flat_card(self):
        for name in ('a delivery address on a pickup', 'item ids that differ'):
            v = vector(name)
            self.assertEqual(v['error'], 'approval_card_invalid')
        base = vector('carter-target')['preview']
        mutations = [
            lambda p: p['items'][0].__setitem__('extra', 1),
            lambda p: p['fulfilment'].__setitem__('instructions', 'leave at gate'),
            lambda p: p['quote']['location'].__setitem__('id', 'elsewhere'),
            lambda p: p['quote'].__setitem__('locationId', 'elsewhere'),
            lambda p: p['quote']['lines'][0].__setitem__('itemId', 'other'),
            lambda p: p.__setitem__('note', ' '),
        ]
        for mutate in mutations:
            p = copy.deepcopy(base); mutate(p)
            with self.assertRaisesRegex(ValueError, '^approval_card_invalid$'):
                fk.card_fields(p)

    def test_flat_card_refused_unless_the_daemon_says_requested(self):
        result = self.app_answer()
        self.prepare(result); self.next_turn()
        for decision in ('autonomous', 'supervised', 'granted', None):
            ap = self.daemon(decision=decision)
            self.assertEqual(self.confirm(result['draftId'], ap)['error'], 'approval_refused')
            ap.wait.assert_not_called(); ap.start.assert_not_called()
        ap = self.daemon(); ap.propose.side_effect = lambda *a: answer(ok=True, task='propose:' + 'a' * 32, decision='requested', payload_hash='0' * 64)
        self.assertEqual(self.confirm(result['draftId'], ap)['error'], 'approval_refused')
        self.transport.assert_not_called()

    def test_one_key_per_draft_and_a_replayed_prepare_cannot_change_the_card(self):
        result = self.app_answer()
        self.prepare(result)
        before = self.record_path(result['draftId']).read_bytes()
        # Same draft, other shape or other words: refused, the first record stays.
        legacy = self.app_answer(shape='legacy')
        self.assertEqual(self.prepare(legacy)['error'], 'village_unavailable')
        self.prepare(result)  # an identical replay is fine
        self.assertEqual(self.record_path(result['draftId']).read_bytes(), before)
        self.next_turn(); ap = self.daemon()
        self.confirm(result['draftId'], ap); self.confirm(result['draftId'], ap)
        self.assertEqual({c.args[1] for c in ap.propose.call_args_list}, {KEY + result['draftId']})
        self.assertEqual({c.args[3] for c in ap.propose.call_args_list}, {fk.canonical(result['approvalPayload'])})


class FlatCardHeaderTest(unittest.TestCase):
    """The app emits the four-key payload only for a box that says it accepts it (context L17737)."""
    def test_prepare_alone_carries_the_flat_card_header(self):
        response = unittest.mock.MagicMock(); response.__enter__.return_value = response; response.read.return_value = b'{}'
        opener = Mock(); opener.open.return_value = response
        config = {'origin': 'https://agents.edgecity.live', 'token': 'not-logged'}
        with patch.object(bridge, 'build_opener', return_value=opener):
            fixture.real_transport(config, {'operation': 'forkicks.order.prepare', 'items': [], 'fulfilment': {}, 'paymentMethod': 'upi'})
            self.assertEqual(opener.open.call_args.args[0].get_header('X-village-forkicks-card'), '1')
            for other in [{'operation': 'forkicks.order.confirm', 'draftId': 'd'}, {'operation': 'forkicks.order.status', 'orderId': 'o'},
                          {'operation': 'forkicks.menu'}, {'operation': 'forkicks.schedule'}, {'operation': 'forkicks.order.cancel', 'orderId': 'o'},
                          {'operation': 'gold-stars.prepare'}, {'operation': 'slopfolio.prepare'}]:
                fixture.real_transport(config, other)
                self.assertIsNone(opener.open.call_args.args[0].get_header('X-village-forkicks-card'), other['operation'])


if __name__ == '__main__': unittest.main()
