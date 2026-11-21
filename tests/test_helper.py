import http.client
import io
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler
import json
import os
from pathlib import Path
import re
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from urllib.parse import urlencode

from helper.server import MAX_BODY, create_app, main
from helper.legacy_css import lower_css


class MemorySocket:
    def __init__(self, payload):
        self.input = io.BytesIO(payload)
        self.output = io.BytesIO()

    def makefile(self, *_args, **_kwargs):
        return self.input

    def sendall(self, data):
        self.output.write(data)


def exchange(handler, server, method, path, headers, body):
    body = body.encode() if isinstance(body, str) else body or b''
    headers = dict(headers)
    headers['Content-Length'] = str(len(body))
    payload = ('%s %s HTTP/1.0\r\n' % (method, path) + ''.join(
        '%s: %s\r\n' % pair for pair in headers.items()) + '\r\n').encode() + body
    sock = MemorySocket(payload)
    handler(sock, ('127.0.0.1', 5555), server)
    response = http.client.HTTPResponse(MemorySocket(sock.output.getvalue()))
    response.begin()
    return response.status, response.getheaders(), response.read()


class Upstream(BaseHTTPRequestHandler):
    watched = 0

    def log_message(self, *_):
        pass

    def do_GET(self):
        if self.path.startswith('/accounts/login'):
            self.send_response(200)
            self.send_header('Set-Cookie', 'csrftoken=testcsrf; Path=/')
            self.end_headers()
            self.wfile.write(b'<html><head></head><body>Login</body></html>')
            return
        if 'sessionid=valid-session' not in self.headers.get('Cookie', ''):
            self.send_response(302)
            self.send_header('Location', '/accounts/login/?next=/')
            self.end_headers()
            return
        scripts = {
            '/static/js/libraries/alpinejs-3.14.9.min.js': b'([u])=>u?.(); o?.set&&o?.get;',
            '/static/js/mediaStatusDateHandler.js': b'this.original.status = statusField?.value || null;',
            '/static/js/date-range.js': (b'const selectedFormat = scriptTag?.dataset.dateFormat; '
                                         b'window.location.href = url.toString();'),
        }
        if (script := scripts.get(self.path.split('?')[0])) is not None:
            self.send_response(200)
            self.send_header('Content-Type', 'text/javascript')
            self.end_headers()
            self.wfile.write(script)
            return
        self.send_response(200)
        self.send_header('Content-Type', 'text/css' if self.path == '/style.css' else 'text/html; charset=utf-8')
        self.end_headers()
        self.wfile.write(b'@layer utilities{.grid{display:grid;&:hover{color:oklch(100% 0 0);}}}'
                         if self.path == '/style.css' else
                         b'<html><head><script defer src="/alpine.js"></script></head><body>Home</body></html>')

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        if self.path == '/accounts/login/':
            if body != b'login=test&password=secret' or 'csrftoken=testcsrf' not in self.headers.get('Cookie', ''):
                self.send_error(403)
                return
            self.send_response(302)
            self.send_header('Set-Cookie', 'sessionid=valid-session; Path=/; HttpOnly')
            self.send_header('Location', '/__tv/approve')
            self.end_headers()
        elif self.path == '/episode_save':
            if ('sessionid=valid-session' not in self.headers.get('Cookie', '') or
                self.headers.get('Origin') != self.server.origin or body != b'watched=1&csrfmiddlewaretoken=testcsrf'):
                self.send_error(403)
                return
            type(self).watched += 1
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.end_headers()
            self.wfile.write(b'<button>Watched</button>')
        elif self.path == '/progress_edit/season/42':
            if ('sessionid=valid-session' not in self.headers.get('Cookie', '') or
                self.headers.get('Origin') != self.server.origin or
                self.headers.get('HX-Request') != 'true' or
                self.headers.get('X-CSRFToken') != 'testcsrf' or
                body not in (b'operation=increase&home_status=in_progress',
                             b'operation=decrease&home_status=in_progress')):
                self.send_error(403)
                return
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            if body.startswith(b'operation=increase'):
                self.send_header('HX-Retarget', '#home-media-season-42')
                self.send_header('HX-Reswap', 'delete')
            self.end_headers()
            if body.startswith(b'operation=decrease'):
                self.wfile.write(b'<button>New progress</button>')
        else:
            self.send_error(404)


class Integration(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.upstream = SimpleNamespace(origin='http://yamtrack.test:8000')
        self.origin = 'http://tv.test:8765'
        self.upstream_request = lambda method, path, headers, body=None: exchange(
            Upstream, self.upstream, method, path, headers, body)
        self.app = create_app(self.upstream.origin, self.origin, Path(self.tmp.name)/'state.json',
                              upstream_request=lambda *args: self.upstream_request(*args))
        self.app.testing = True
        self.client = self.app.test_client(use_cookies=False)
        self.state = self.app.extensions['yamtrack_tv_state']
        self.tv = {}
        self.phone = {}

    def tearDown(self):
        self.tmp.cleanup()

    def request(self, path, cookies=None, method='GET', body=None, origin=None, extra_headers=None):
        cookies = cookies if cookies is not None else {}
        headers = {'Host': 'tv.test:8765', 'Cookie': '; '.join('%s=%s' % (k, v) for k, v in cookies.items())}
        if method == 'POST':
            headers['Origin'] = origin or self.origin
            headers['Content-Type'] = 'application/x-www-form-urlencoded'
        headers.update(extra_headers or {})
        with self.client.open(path, base_url=self.origin, method=method, headers=headers, data=body) as response:
            for value in response.headers.getlist('Set-Cookie'):
                jar = SimpleCookie()
                jar.load(value)
                for name, morsel in jar.items():
                    if morsel['max-age'] == '0':
                        cookies.pop(name, None)
                    else:
                        cookies[name] = morsel.value
            return response.status_code, dict(response.headers), response.get_data()

    def pair(self):
        status, _, body = self.request('/__tv/start', self.tv, 'POST')
        self.assertEqual(status, 200)
        code = json.loads(body)['code']
        status, headers, _ = self.request('/__tv/pair', self.phone, 'POST', urlencode({'code': code}))
        self.assertEqual(status, 303)
        self.assertIn('/accounts/login/', headers['Location'])
        self.request(headers['Location'], self.phone)
        status, _, _ = self.request('/accounts/login/', self.phone, 'POST', 'login=test&password=secret')
        self.assertEqual(status, 302)
        status, _, body = self.request('/__tv/approve', self.phone)
        self.assertEqual(status, 200)
        self.assertIn(b'Approve TV', body)
        self.assertNotIn(b'client.js', body)
        status, _, _ = self.request('/__tv/approve', self.phone, 'POST', urlencode({'nonce': self.phone['ytv_pair']}))
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(self.request('/__tv/status', self.tv)[2])['ready'])

    def test_pair_and_watch_with_upstream_csrf(self):
        self.pair()
        status, _, body = self.request('/', self.tv)
        self.assertEqual(status, 200)
        self.assertIn(b'/__tv/client.js', body)
        self.assertNotIn('sessionid', self.tv)  # Session remains at helper.
        count = Upstream.watched
        status, _, body = self.request('/episode_save', self.tv, 'POST', 'watched=1&csrfmiddlewaretoken=testcsrf')
        self.assertEqual(status, 200)
        self.assertEqual(Upstream.watched, count+1)
        self.assertEqual(body, b'<button>Watched</button>')
        self.assertEqual(self.request('/episode_save', self.tv, 'POST', 'watched=1', 'http://evil.invalid')[0], 403)
        state = Path(self.tmp.name)/'state.json'
        self.assertEqual(state.stat().st_mode & 0o777, 0o600)
        self.assertNotIn('secret', state.read_text())
        self.assertNotIn(self.tv['ytv_device'], state.read_text())

    def test_approved_pairing_survives_recreating_the_app(self):
        self.pair()
        restarted = create_app(self.upstream.origin, self.origin, self.state.path,
                               upstream_request=self.upstream_request)
        self.client = restarted.test_client(use_cookies=False)
        self.assertTrue(json.loads(self.request('/__tv/status', self.tv)[2])['ready'])
        self.assertEqual(self.request('/', self.tv)[0], 200)

    def test_proxy_preserves_the_raw_path_query_and_repeated_response_headers(self):
        self.pair()
        target = '/details/tmdb/movie/42/Am%C3%A9lie?tag=a%2Fb&tag=c+d'

        def upstream_request(method, path, headers, body):
            self.assertEqual((method, path, body), ('GET', target, None))
            self.assertEqual(headers['Referer'], self.upstream.origin + '/search?q=One+Two')
            self.assertIn('sessionid=valid-session', headers['Cookie'])
            self.assertNotIn('ytv_device=', headers['Cookie'])
            return 200, [('Content-Type', 'text/html'),
                         ('Set-Cookie', 'csrftoken=updated; Domain=yamtrack.test; Path=/'),
                         ('Set-Cookie', 'sessionid=updated-session; Path=/')], b'<p>Fragment</p>'

        self.upstream_request = upstream_request
        with self.client.get('/decoded-route', base_url=self.origin,
                             environ_overrides={'REQUEST_URI': target},
                             headers={'Cookie': 'ytv_device=' + self.tv['ytv_device'],
                                      'Referer': self.origin + '/search?q=One+Two'}) as response:
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_data(), b'<p>Fragment</p>')
            cookies = response.headers.getlist('Set-Cookie')
            self.assertEqual(len(cookies), 2)
            self.assertTrue(all(cookie.startswith('csrftoken=updated;') and 'Domain=' not in cookie
                                for cookie in cookies))

    def test_flask_routes_preserve_http_limits_and_the_local_namespace(self):
        self.assertEqual(self.request('/__tv/', extra_headers={'Host': 'wrong.test'})[0], 400)
        self.assertEqual(self.request('/__tv/client.js', method='POST')[0], 405)
        self.assertEqual(self.request('/__tv/unknown')[0], 404)
        status, headers, body = self.request('/__tv/client.css', method='HEAD')
        self.assertEqual((status, body, headers['Cache-Control']), (200, b'', 'no-store'))
        response = self.client.post('/__tv/start', base_url=self.origin,
                                    environ_overrides={'CONTENT_LENGTH': str(MAX_BODY + 1)})
        self.assertEqual(response.status_code, 413)

    def test_tv_compat_loads_before_alpine(self):
        self.pair()
        status, _, body = self.request('/details/tmdb/tv/123/show/season/2', self.tv)
        self.assertEqual(status, 200)
        compat = b'<script src="/__tv/compat.js"></script>'
        stylesheet = b'<link rel="stylesheet" href="/__tv/compat.css">'
        self.assertLess(body.index(compat), body.index(b'<script defer src="/alpine.js">'))
        self.assertLess(body.index(b'<style>html{background:'), body.index(compat))
        self.assertIn(b'<script defer src="/__tv/navigation.js"></script>', body)
        self.assertIn(stylesheet, body)
        self.assertNotIn(compat, self.request('/', self.phone)[2])
        self.assertNotIn(stylesheet, self.request('/', self.phone)[2])
        status, headers, script = self.request('/__tv/compat.js', self.tv)
        self.assertEqual(status, 200)
        self.assertEqual(headers['Content-Type'], 'application/javascript')
        self.assertIn(b'queueMicrotask', script)
        status, headers, css = self.request('/__tv/compat.css', self.tv)
        self.assertEqual((status, headers['Content-Type']), (200, 'text/css'))
        self.assertIn(b'.ytv-modal', css)

    def test_pairing_and_tv_pages_share_same_origin_font_faces(self):
        self.pair()
        for path, cookies in (('/__tv/', {}), ('/', self.tv)):
            with self.subTest(path=path):
                _, _, page = self.request(path, cookies)
                self.assertIn(b'<link rel="stylesheet" href="/__tv/fonts.css">', page)
                self.assertIn(b'400.woff" as="font" type="font/woff" crossorigin>', page)
        self.assertNotIn(b'/__tv/fonts.css', self.request('/', self.phone)[2])

        status, headers, css = self.request('/__tv/fonts.css')
        self.assertEqual((status, headers['Cache-Control']), (200, 'no-store'))
        faces = re.findall(rb'url\("(/__tv/fonts/[^"\s]+)"\)', css)
        self.assertEqual(len(faces), 5)
        for url in faces:
            with self.subTest(url=url):
                status, headers, font = self.request(url.decode())
                self.assertEqual((status, headers['Content-Type'], font[:4]), (200, 'font/woff', b'wOFF'))
                self.assertIn('max-age=31536000', headers['Cache-Control'])
        status, headers, _ = self.request(faces[0].decode(), extra_headers={'Host': 'wrong.test'})
        self.assertEqual((status, headers['Cache-Control']), (400, 'no-store'))

    def test_home_progress_preserves_htmx_post_and_swap(self):
        self.pair()
        extra = {'HX-Request': 'true', 'X-CSRFToken': 'testcsrf'}
        endpoint = '/progress_edit/season/42'
        status, _, body = self.request(endpoint, self.tv, 'POST',
                                       'operation=decrease&home_status=in_progress', extra_headers=extra)
        self.assertEqual((status, body), (200, b'<button>New progress</button>'))
        status, headers, _ = self.request(endpoint, self.tv, 'POST',
                                          'operation=increase&home_status=in_progress', extra_headers=extra)
        self.assertEqual(status, 200)
        self.assertEqual(headers['HX-Retarget'], '#home-media-season-42')
        self.assertEqual(headers['HX-Reswap'], 'delete')

    def test_expired_code_and_unapproved_tv(self):
        code = json.loads(self.request('/__tv/start', self.tv, 'POST')[2])['code']
        self.assertEqual(self.request('/', self.tv)[1]['Location'], '/__tv/')
        self.state.pending[code]['expires'] = 0
        self.assertEqual(self.request('/__tv/pair', self.phone, 'POST', 'code='+code)[0], 400)
        self.assertTrue(json.loads(self.request('/__tv/status', self.tv)[2])['expired'])

    def test_approval_requires_login_and_nonce(self):
        code = json.loads(self.request('/__tv/start', self.tv, 'POST')[2])['code']
        self.request('/__tv/pair', self.phone, 'POST', 'code='+code)
        self.assertEqual(self.request('/__tv/approve', self.phone, 'POST', 'nonce=wrong')[0], 303)
        self.phone.update({'sessionid': 'valid-session', 'csrftoken': 'testcsrf'})
        self.assertEqual(self.request('/__tv/approve', self.phone, 'POST', 'nonce=wrong')[0], 403)
        self.assertFalse(json.loads(self.request('/__tv/status', self.tv)[2])['ready'])

    def test_expired_session_returns_to_pairing(self):
        self.pair()
        next(iter(self.state.devices.values()))['sessionid'] = 'expired'
        self.assertEqual(self.request('/', self.tv)[1]['Location'], '/__tv/')
        self.assertFalse(self.state.devices)

    def test_only_tv_css_is_lowered(self):
        self.pair()
        self.assertNotIn(b'@layer', self.request('/style.css', self.tv)[2])
        self.assertIn(b'@layer', self.request('/style.css', self.phone)[2])

    def test_only_tv_gets_legacy_alpine_and_tracker_scripts(self):
        self.pair()
        for path, rewrite in (
            ('/static/js/libraries/alpinejs-3.14.9.min.js', b'([u])=>u==null?void 0:u()'),
            ('/static/js/mediaStatusDateHandler.js?123', b'(statusField == null ? undefined : statusField.value)'),
        ):
            with self.subTest(path=path):
                status, _, script = self.request(path, self.tv)
                self.assertEqual(status, 200)
                self.assertIn(rewrite, script)
                self.assertNotIn(b'?.', script)
                self.assertIn(b'?.', self.request(path, self.phone)[2])

    def test_tv_date_picker_routes_query_changes_through_page_navigation(self):
        self.pair()
        path = '/static/js/date-range.js?123'
        status, _, script = self.request(path, self.tv)
        self.assertEqual(status, 200)
        self.assertIn(b"CustomEvent('ytv:navigate'", script)
        self.assertIn(b'cancelable:true', script)
        self.assertNotIn(b'?.', script)
        self.assertIn(b'window.location.href = url.toString();', self.request(path, self.phone)[2])

    def test_qr_screen_and_scanned_code_prefill(self):
        status, _, body = self.request('/__tv/', self.tv)
        self.assertEqual(status, 200)
        self.assertIn(b'id="qr-code"', body)
        self.assertIn(b'src="/__tv/qr.js"', body)
        self.assertIn(b'http://tv.test:8765/__tv/pair', body)
        self.assertEqual(self.request('/__tv/qr.js')[0], 200)
        code = json.loads(self.request('/__tv/start', self.tv, 'POST')[2])['code']
        status, _, body = self.request('/__tv/pair?code='+code, self.phone)
        self.assertEqual(status, 200)
        self.assertIn(('value="%s"' % code).encode(), body)
        self.assertIn(b'action="/__tv/pair"', body)
        self.assertNotIn('ytv_pair', self.phone)  # Scanning alone never approves a TV.
        self.assertFalse(self.state.devices)
        body = self.request('/__tv/pair?code=%22%3E%3Cscript%3E', self.phone)[2]
        self.assertIn(b'value=""', body)
        self.assertNotIn(b'<script>', body)


class Startup(unittest.TestCase):
    def test_request_logs_omit_pairing_codes_and_calendar_tokens(self):
        app = create_app('http://yamtrack.test', 'http://tv.test', state_path='',
                         upstream_request=lambda *_args: (200, [], b'calendar'))
        client = app.test_client()
        with self.assertLogs(app.logger, level='INFO') as logs:
            client.get('/__tv/pair?code=123456', base_url='http://tv.test')
            client.get('/calendar/ical/private-token', base_url='http://tv.test')
        self.assertEqual([entry.getMessage() for entry in logs.records], [
            "'GET' pairing_form 200",
            "'GET' forward 200",
        ])

    def test_helper_origins_are_required_and_normalized(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(ValueError, 'Set YAMTRACK_URL'):
                create_app(state_path='')
            with self.assertRaisesRegex(ValueError, 'Set TV_PUBLIC_URL'):
                create_app('http://yamtrack.test:8000', state_path='')
        for invalid in ('tv.test', 'http://user:pass@tv.test', 'http://tv.test:invalid', 'https://tv.test/path'):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(ValueError, 'Set TV_PUBLIC_URL'):
                create_app('http://yamtrack.test:8000', invalid, state_path='')
        app = create_app('http://yamtrack.test:8000', 'https://TV.TEST:443/', state_path='')
        response = app.test_client().get('/__tv/', base_url='https://tv.test')
        self.assertEqual(response.status_code, 200)
        self.assertIn(b'https://tv.test/__tv/pair', response.data)

    def test_waitress_worker_count_defaults_to_eight_and_can_be_overridden(self):
        serve = Mock()
        origins = {'YAMTRACK_URL': 'http://yamtrack.test:8000', 'TV_PUBLIC_URL': 'http://tv.test:8765'}
        with patch.dict('sys.modules', {'waitress': SimpleNamespace(serve=serve)}):
            for env, expected in (({}, 8), ({'TV_THREADS': '12'}, 12)):
                with self.subTest(env=env), patch.dict(os.environ, origins | env, clear=True):
                    main()
                    self.assertEqual(serve.call_args.kwargs['threads'], expected)
            serve.reset_mock()
            for value in ('0', '-1', 'four'):
                with self.subTest(value=value), patch.dict(os.environ, {'TV_THREADS': value}, clear=True):
                    with self.assertRaisesRegex(SystemExit, 'TV_THREADS must be a positive integer'):
                        main()
            serve.assert_not_called()


class CSS(unittest.TestCase):
    def test_gap_inset_and_transforms_have_legacy_declarations(self):
        css = lower_css('''@layer utilities{
          .gutter{gap:var(--spacing) 2rem;column-gap:1rem;}
          .overlay{inset:0 2rem;}
          .move{translate:0 -50%;}
          .turn{rotate:180deg;}
          .size{--tw-scale-x:95%;scale:var(--tw-scale-x) 100%;}
        }''')
        self.assertIn('grid-gap:var(--spacing) 2rem;gap:var(--spacing) 2rem;', css)
        self.assertIn('grid-column-gap:1rem;column-gap:1rem;', css)
        self.assertIn('.overlay{top:0;right:2rem;bottom:0;left:2rem;}', css)
        self.assertIn('--ytv-translate:translate(0,-50%);transform:', css)
        self.assertIn('--ytv-rotate:rotate(180deg);transform:', css)
        self.assertIn('--tw-scale-x:0.95;--ytv-scale:scale(var(--tw-scale-x),1);transform:', css)

    def test_tailwind_features(self):
        css = lower_css('''@layer theme{:root{--color-white:oklch(100% 0 0);--spacing:.25rem;}}
        @layer utilities{.grid{display:grid;} .px-4{padding-inline:calc(var(--spacing) * 4);}
        .button{color:red;&:hover{color:rgb(0 0 0 / 0.5);}}
        @media(width >= 64rem){.lg\\:flex{display:flex;}}}
        @property --tw-translate-x{syntax:"*";inherits:false;initial-value:0;}
        ''')
        self.assertNotIn('@layer', css)
        self.assertNotIn('@property', css)
        self.assertIn('rgb(255,255,255)', css)
        self.assertIn('padding-left:1rem;padding-right:1rem;', css)
        self.assertIn('.button:hover{color:rgba(0,0,0,0.5);}', css)
        self.assertIn('@media(min-width:64rem)', css)
        self.assertIn('--tw-translate-x:0;', css)

    def test_selector_groups_and_quoted_delimiters(self):
        css = lower_css('''@layer base{input,::file-selector-button{color:red;}}
        @layer utilities{.group{&:is(:focus,:hover){content:"a;b{c}";}}}''')
        self.assertIn('input{color:red;}', css)
        self.assertNotIn('::file-selector-button{color:red', css)
        self.assertIn('.group:focus,.group:hover', css)
        self.assertIn('content:"a;b{c}"', css)

    def test_tv_layout_and_pointer_styles(self):
        css = lower_css(r'''@layer utilities{
          .space-y-4{:where(& > :not(:last-child)){margin-block-end:calc(var(--spacing) * 4);}}
          .w-1\/2{width:calc(1/2 * 100%);}
          .bg-black\/50{background-color:color-mix(in srgb, #000 50%, transparent);}
          .hover-tap\:opacity-100{&:hover{opacity:100%;}}
          .group-hover\:flex{&:is(:where(.group):hover *){display:flex;}}
          .shadow-\[0_0_1px_rgba\(0\,0\,0\,1\)\]{color:red;}
        }''')
        self.assertIn('.space-y-4 > :not(:last-child){margin-bottom:1rem;}', css)
        self.assertIn(r'.w-1\/2{width:50%;}', css)
        self.assertIn('background-color:rgba(0,0,0,0.5);', css)
        self.assertIn(r'.hover-tap\:opacity-100:hover{opacity:1;}', css)
        self.assertIn(r'.group:hover .group-hover\:flex{display:flex;}', css)
        self.assertIn(r'.shadow-\[0_0_1px_rgba\(0\,0\,0\,1\)\]{color:red;}', css)


if __name__ == '__main__':
    unittest.main()
