"""Offline native boundary tests; real Hermes parser half requires HERMES_AGENT_SRC."""
import base64
import copy
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch
import zlib
import test_bridge as fixture

bridge, mini = fixture.bridge, fixture.mini
media = sys.modules['village_bridge._forkicks_media']


def envelope():
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b'\x00\xff\xff\xff')) + chunk(b'IEND', b'')
    return {'kind': 'forkicks-menu-image', 'revision': 'a' * 64, 'theme': 'chalk', 'provisional': False,
            'menu': {'location': None, 'items': [], 'deliveryMinimumDrinks': 3, 'agentOrdersPaused': False, 'pilotNote': ''},
            'pages': [{'mimeType': 'image/png', 'filename': 'menu-1.png', 'width': 1, 'height': 1, 'altText': 'For Kicks\nMenu is empty.', 'base64': base64.b64encode(png).decode()}]}


class MenuMediaTest(unittest.TestCase):
    setUp = fixture.BridgeTest.setUp
    call = fixture.BridgeTest.call

    def enable(self):
        Path(self.tmp.name, 'mini-apps.json').write_text(json.dumps({'version': 1, 'apps': [{'id': 'forkicks', **mini.FORKICKS}]}))

    def test_raw_result_materializes_real_png_private_under_home_and_text_default_unchanged(self):
        self.enable()
        doc = envelope(); self.transport.return_value = doc
        raw = bridge.handle({'operation': 'forkicks.menu', 'format': 'image'})
        self.assertTrue(raw.startswith('MEDIA:"'))
        filename = Path(raw.splitlines()[0][7:-1])
        self.assertTrue(filename.is_relative_to(Path(self.tmp.name, 'cache', 'images', 'forkicks')))
        self.assertEqual(filename.stat().st_mode & 0o777, 0o600)
        self.assertEqual(filename.parent.stat().st_mode & 0o777, 0o700)
        self.assertEqual(filename.read_bytes(), base64.b64decode(doc['pages'][0]['base64']))
        self.assertIn('Menu is empty.', raw)
        self.assertNotIn(self.config['token'], raw)
        self.assertEqual(self.call({'operation': 'forkicks.menu'})['data'], doc)

    def test_pickup_only_boolean_is_accepted_and_preserved_with_image_text(self):
        self.enable()
        for pickup_only in (True, False):
            doc = envelope()
            item = {'id': 'coffee', 'name': 'Coffee', 'category': 'Coffee', 'description': '',
                    'priceInr': 190, 'countsAsDrink': True, 'available': True,
                    'pickupOnly': pickup_only, 'optionGroups': []}
            doc['menu']['items'] = [item]
            doc['pages'][0]['altText'] = 'Coffee — pickup only' if pickup_only else 'Coffee'
            self.transport.return_value = doc
            raw = bridge.handle({'operation': 'forkicks.menu', 'format': 'image'})
            self.assertTrue(raw.startswith('MEDIA:"'))
            self.assertIn(doc['pages'][0]['altText'], raw)
            self.assertIs(doc['menu']['items'][0]['pickupOnly'], pickup_only)
            for invalid in ('true', 1, None):
                bad = copy.deepcopy(doc)
                bad['menu']['items'][0]['pickupOnly'] = invalid
                with self.assertRaises(ValueError):
                    media.validated_pages(bad, 'chalk')
            del doc['menu']['items'][0]['pickupOnly']
            with self.assertRaises(ValueError):
                media.validated_pages(doc, 'chalk')

    def test_theme_requires_image_and_extra_args_refused_before_transport(self):
        self.enable()
        for args in ({'theme': 'paper'}, {'format': 'pdf'}, {'format': 'image', 'theme': 'other'}, {'format': 'image', 'url': 'https://example.test'}):
            self.assertEqual(self.call({'operation': 'forkicks.menu', **args})['error'], 'village_unavailable')
        self.transport.assert_not_called()

    def test_uninstalled_and_group_guards_still_block_images(self):
        self.assertEqual(self.call({'operation': 'forkicks.menu', 'format': 'image'})['error'], 'mini_app_not_installed')
        self.enable(); self.sc._VAR_MAP['HERMES_SESSION_CHAT_TYPE'].set('group')
        self.assertEqual(self.call({'operation': 'forkicks.menu', 'format': 'image'})['error'], 'private_owner_chat_required')
        self.transport.assert_not_called()

    def test_invalid_media_returns_current_text_without_partial_attachments(self):
        self.enable()
        doc = envelope()
        mutations = [{'url': 'https://example.test'}, {'pages': []}, {'theme': 'paper'}, {'revision': '../bad'}]
        for mutation in mutations:
            bad = {**doc, **mutation}
            self.transport.side_effect = [bad, doc['menu']]
            output = self.call({'operation': 'forkicks.menu', 'format': 'image'})
            self.assertEqual(output['error'], 'forkicks_menu_image_unavailable')
            self.assertEqual(output['menu'], doc['menu'])
            self.assertNotIn('MEDIA:', json.dumps(output))
        self.assertFalse(Path(self.tmp.name, 'cache').exists())

    def test_traversal_bad_base64_dimensions_crc_and_page_limits_refused(self):
        for change in ({'filename': '../../secret.png'}, {'base64': 'a' * 44}, {'width': 4000}, {'mimeType': 'image/svg+xml'}, {'altText': ''}, {'height': True}):
            doc = envelope(); doc['pages'][0].update(change)
            with self.assertRaises((ValueError, TypeError)):
                media.validated_pages(doc, 'chalk')
        doc = envelope(); data = bytearray(base64.b64decode(doc['pages'][0]['base64'])); data[29] ^= 1
        doc['pages'][0]['base64'] = base64.b64encode(data).decode()
        with self.assertRaises(ValueError): media.validated_pages(doc, 'chalk')
        doc = envelope(); doc['pages'] *= 13
        with self.assertRaises(ValueError): media.validated_pages(doc, 'chalk')
        doc = envelope(); doc['pages'] *= 2
        with self.assertRaises(ValueError): media.validated_pages(doc, 'chalk')

    def test_symlink_cache_is_not_traversed_and_failure_retains_text(self):
        self.enable(); doc = envelope(); self.transport.return_value = doc
        with tempfile.TemporaryDirectory() as outside:
            Path(self.tmp.name, 'cache').symlink_to(outside, target_is_directory=True)
            response = self.call({'operation': 'forkicks.menu', 'format': 'image'})
            self.assertEqual(response['error'], 'forkicks_menu_image_unavailable')
            self.assertEqual(response['menu'], doc['menu'])
            self.assertEqual(list(Path(outside).iterdir()), [])

    def test_network_failure_retains_current_text_and_full_failure_offers_text_read(self):
        self.enable(); doc = envelope()
        self.transport.side_effect = [TimeoutError(), doc['menu']]
        result = self.call({'operation': 'forkicks.menu', 'format': 'image'})
        self.assertEqual(result['error'], 'forkicks_menu_image_unavailable')
        self.assertEqual(result['menu'], doc['menu'])
        self.transport.side_effect = TimeoutError()
        result = self.call({'operation': 'forkicks.menu', 'format': 'image'})
        self.assertNotIn('menu', result)
        self.assertIn('without format', result['instruction'])

    def test_every_page_is_emitted_and_requested_filters_are_forwarded_unchanged(self):
        self.enable(); doc = envelope(); doc['theme'] = 'paper'; doc['provisional'] = True
        doc['pages'].append({**copy.deepcopy(doc['pages'][0]), 'filename': 'menu-2.png', 'altText': 'Second page'})
        self.transport.return_value = doc
        request = {'operation': 'forkicks.menu', 'format': 'image', 'theme': 'paper', 'date': '2026-10-19', 'locationId': 'cafe'}
        result = bridge.handle(request)
        self.assertEqual(sum(line.startswith('MEDIA:') for line in result.splitlines()), 2)
        self.assertIn('Paper concept is provisional.', result)
        self.assertIn('Second page', result)
        self.transport.assert_called_once_with(self.config, request)

    def test_image_transport_has_bounded_bytes_and_duplicate_keys_refused(self):
        response = unittest.mock.MagicMock(); response.__enter__.return_value = response
        opener = unittest.mock.Mock(); opener.open.return_value = response
        with patch.object(bridge, 'build_opener', return_value=opener):
            response.read.return_value = b'{"kind":1,"kind":2}'
            with self.assertRaises(ValueError): fixture.real_transport(self.config, {'operation': 'forkicks.menu', 'format': 'image'})
            response.read.assert_called_with(media.JSON_BYTES + 1)
            response.read.return_value = b'x' * (media.JSON_BYTES + 1)
            self.assertEqual(fixture.real_transport(self.config, {'operation': 'forkicks.menu', 'format': 'image'})['error'], 'response_too_large')


@unittest.skipUnless(os.environ.get('HERMES_AGENT_SRC'), 'set HERMES_AGENT_SRC to the actual pinned Hermes source')
class RealHermesParserTest(unittest.TestCase):
    def test_actual_parser_recognizes_raw_markers_but_masks_json_string_markers(self):
        # test_bridge's stubs are restored after each unit test; do not substitute
        # an invented marker regex for the real runtime implementation.
        sys.path.insert(0, os.environ['HERMES_AGENT_SRC'])
        from gateway.platforms.base import BasePlatformAdapter
        with tempfile.TemporaryDirectory() as home:
            doc = envelope(); doc['pages'][0]['altText'] += '\nMEDIA:/etc/secret.png'
            raw = media.materialize(Path(home), doc, 'chalk')
            files, cleaned = BasePlatformAdapter.extract_media(raw)
            self.assertEqual(len(files), 1)
            self.assertTrue(Path(files[0][0]).is_file())
            self.assertIn('Menu is empty.', cleaned)
            self.assertNotIn('/etc/secret.png', [path for path, _ in files])
            serialized = json.dumps({'result': 'MEDIA:' + files[0][0]})
            self.assertEqual(BasePlatformAdapter.extract_media(serialized)[0], [])
