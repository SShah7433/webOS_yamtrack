"""Flask routes for LAN-only Yamtrack pairing and TV proxying."""
from datetime import datetime, timezone
from functools import partial, wraps
import hashlib
import html
import http.client
import json
import logging
import os
from pathlib import Path
import re
import secrets
import tempfile
import threading
import time
from urllib.parse import urlencode, urlsplit

from flask import Flask, Response, jsonify, redirect, request, send_from_directory
from werkzeug.routing import PathConverter

from .compatibility import FONT_LINKS
from .proxy import (COOKIES, UpstreamBusy, connection_headers, cookie_header, cookie_values,
                    origin_of, proxy, request_target, request_upstream)

STATIC = Path(__file__).parent / "static"
DEVICE_COOKIE = "ytv_device"
PAIR_COOKIE = "ytv_pair"
TTL = 600
ISSUE_LIMIT = 4
MAX_BODY = 4 * 1024 * 1024
LOGIN_PATH = "/accounts/login/"
LOGIN_ASSET = re.compile(r"/static/(?:[A-Za-z0-9_][A-Za-z0-9_.-]*/)*[A-Za-z0-9_][A-Za-z0-9_.-]*")
SERVER_NAME = "Yamtrack"
access_log = logging.getLogger("yamtrack.access")


class StateWriteError(Exception):
    pass


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


class State:
    def __init__(self, path):
        self.path = Path(path) if path else None
        self.lock = threading.RLock()
        self.devices = {}
        self.pending = {}
        self.attempts = {}
        self.issued = {}
        self.css_cache = {}
        if self.path and self.path.exists():
            records = json.loads(self.path.read_text())
            if not isinstance(records, dict) or any(
                not re.fullmatch(r"[a-f0-9]{64}", key) or not isinstance(cookies, dict)
                or any(not isinstance(value, str) for value in cookies.values())
                for key, cookies in records.items()
            ):
                raise ValueError("Invalid TV session file.")
            self.devices = {key: {name: value for name, value in cookies.items() if name in COOKIES}
                            for key, cookies in records.items() if cookies.get("sessionid")}

    def save(self, devices):
        if not self.path:
            return
        temporary = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(mode="w", dir=self.path.parent, delete=False) as target:
                temporary = Path(target.name)
                json.dump(devices, target)
                target.flush()
                os.fsync(target.fileno())
            temporary.replace(self.path)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)

    def commit_device(self, key, expected, cookies):
        if self.devices.get(key) is not expected:
            return
        records = self.devices.copy()
        if cookies is None:
            records.pop(key, None)
        else:
            records[key] = cookies
        try:
            self.save(records)
        except OSError as error:
            raise StateWriteError from error
        self.devices = records

    def clean(self):
        now = time.time()
        self.pending = {k: v for k, v in self.pending.items() if v["expires"] > now}
        self.attempts = {k: v for k, v in self.attempts.items() if v[0] > now - 60}
        self.issued = {k: v for k, v in self.issued.items() if v[0] > now - TTL}


def page(title, body, status=200):
    return Response(
        '<!doctype html><html lang="en"><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '<title>' + html.escape(title) + '</title>' + FONT_LINKS + '<link rel="stylesheet" href="/__tv/pair.css">'
        '<main><p class="eyebrow">YAMTRACK</p><h1>' + html.escape(title) + '</h1>'
        + body + '</main></html>',
        status=status,
        mimetype="text/html",
    )


def same_origin(public_url):
    # Validate the browser's origin before forwarding Yamtrack's CSRF headers.
    origin = request.headers.get("Origin")
    if origin:
        return origin.rstrip("/") == public_url
    referer = request.headers.get("Referer")
    if referer:
        return origin_of(referer) == public_url
    return request.headers.get("Sec-Fetch-Site") not in ("cross-site", "same-site")


def requires_login(status, headers):
    if status in (401, 403):
        return True
    if status not in (301, 302, 303, 307, 308):
        return False
    excluded = connection_headers([value for key, value in headers if key.lower() == "connection"])
    if "location" in excluded:
        return False
    for key, value in headers:
        if key.lower() == "location":
            try:
                return urlsplit(value).path.rstrip("/") == LOGIN_PATH.rstrip("/")
            except ValueError:
                return False
    return False


class YamtrackPath(PathConverter):
    regex = r"(?!__tv/)[^/].*?"


class YamtrackApp(Flask):
    def log_exception(self, exc_info):
        self.logger.error("Exception handling %r %s", request.method,
                          request.endpoint or "unmatched", exc_info=exc_info)


def configured_origin(name, value):
    value = os.environ.get(name, "") if value is None else value
    message = f"Set {name} to an HTTP(S) origin with a host and optional port."
    try:
        origin = urlsplit(value.strip().rstrip("/"))
        port = origin.port
    except ValueError:
        raise ValueError(message) from None
    if (origin.scheme not in ("http", "https") or not origin.hostname or origin.username is not None or
            origin.path or origin.query or origin.fragment or any(char.isspace() for char in origin.netloc)):
        raise ValueError(message)
    host = origin.netloc.lower().rstrip(":")
    if port == (443 if origin.scheme == "https" else 80):
        host = host.rsplit(":", 1)[0]
    return origin._replace(netloc=host)


def create_app(upstream_url=None, public_url=None, state_path=None, *, upstream_request=None,
               upstream_slots=6):
    if state_path is None:
        state_path = os.environ.get("TV_STATE", "data/sessions.json")
    upstream = configured_origin("YAMTRACK_URL", upstream_url)
    public = configured_origin("TV_PUBLIC_URL", public_url)
    public_url = public.geturl()

    app = YamtrackApp(__name__, static_folder=None)
    app.config["MAX_CONTENT_LENGTH"] = MAX_BODY
    app.url_map.merge_slashes = False
    app.url_map.converters["yamtrack"] = YamtrackPath
    state = State(state_path)
    app.extensions["yamtrack_tv_state"] = state
    probe_upstream = upstream_request
    if upstream_request is None:
        upstream_request = partial(request_upstream, upstream)
        probe_upstream = partial(request_upstream, upstream, read_body=False)
    slots = threading.BoundedSemaphore(upstream_slots)

    def limit_upstream(handler):
        @wraps(handler)
        def limited(*args, **kwargs):
            if not slots.acquire(blocking=False):
                raise UpstreamBusy
            try:
                return handler(*args, **kwargs)
            finally:
                slots.release()

        return limited

    def set_cookie(response, name, value, age):
        response.set_cookie(name, value, max_age=age, httponly=True, path="/",
                            samesite="Lax", secure=public.scheme == "https")
        return response

    def device_key():
        return digest(request.cookies.get(DEVICE_COOKIE, ""))

    @app.before_request
    def validate_request():
        if request.headers.get("Host", "").lower() != public.netloc.lower():
            return "Use the configured TV_PUBLIC_URL.", 400
        if request.method == "POST" and not same_origin(public_url):
            return "Cross-origin requests are not allowed.", 403
        length = request.headers.get("Content-Length")
        try:
            size = int(length) if length is not None else 0
        except ValueError:
            return "Invalid content length.", 400
        if size < 0 or size > MAX_BODY or request.headers.get("Transfer-Encoding"):
            return "Request too large or unsupported encoding.", 413

    @app.after_request
    def response_headers(response):
        if request.endpoint != "font_asset" or response.status_code not in (200, 206, 304):
            response.headers["Cache-Control"] = "no-store"
        response.headers.update({
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "same-origin",
            "X-Frame-Options": "DENY",
        })
        routes = {"forward": "/<yamtrack>", "static_asset": "/__tv/<asset>",
                  "font_asset": "/__tv/fonts/<font>"}
        path = routes.get(request.endpoint, request.url_rule.rule if request.url_rule else "<unmatched>")
        protocol = request.environ.get("SERVER_PROTOCOL", "-")
        request_line = json.dumps(f"{request.method} {path} {protocol}")
        timestamp = datetime.now(timezone.utc).strftime("%d/%b/%Y:%H:%M:%S %z")
        size = response.content_length
        if request.method == "HEAD" or response.status_code in (204, 304) or response.status_code < 200:
            size = None
        access_log.info("%s - - [%s] %s %d %s", request.remote_addr or "-", timestamp,
                        request_line, response.status_code, size or "-")
        return response

    def unavailable(error):
        app.logger.warning("Yamtrack request failed while handling %s (%s)",
                           request.endpoint, type(error).__name__)
        return page("Yamtrack is unavailable",
                    '<p>Check that Yamtrack is running at ' + html.escape(upstream.geturl())
                    + '.</p><a href="/">Try again</a>', 502)

    app.register_error_handler(OSError, unavailable)
    app.register_error_handler(http.client.HTTPException, unavailable)
    app.register_error_handler(UpstreamBusy, lambda _: ("Yamtrack is busy. Try again shortly.", 503))

    @app.errorhandler(StateWriteError)
    def state_unavailable(error):
        app.logger.warning("Could not save TV sessions (%s)", type(error.__cause__).__name__)
        return page("Could not save TV sessions", "<p>Check the helper's data directory and try again.</p>", 503)

    @app.get("/__tv/<any(pair.css,pair.js,qr.js,client.css,client.js,compat.css,compat.js,navigation.js,fonts.css):filename>")
    def static_asset(filename):
        mime = "text/css" if filename.endswith(".css") else "application/javascript"
        response = send_from_directory(STATIC, filename, mimetype=mime, conditional=False, etag=False)
        response.content_type = mime
        return response

    @app.get("/__tv/fonts/roboto-flex-3.2-<any('400','400-italic','500','600','700'):style>.woff")
    def font_asset(style):
        return send_from_directory(STATIC / "fonts", f"roboto-flex-3.2-{style}.woff",
                                   mimetype="font/woff", max_age=31536000)

    @app.get("/__tv/")
    def pairing_screen():
        return page("Sign in with your phone", '<div class="pair-layout">'
                    '<svg id="qr-code" role="img" aria-label="Scan to open phone pairing" hidden></svg>'
                    '<div class="pair-details"><p>Scan the QR code with a phone on your home Wi-Fi.</p>'
                    '<p>Or open this address and enter the code:</p>'
                    '<a id="pair-address" class="address" href="' + html.escape(public_url + '/__tv/pair')
                    + '">' + html.escape(public_url + '/__tv/pair') + '</a>'
                    '<div id="code" aria-live="polite">Connecting…</div><p id="status"></p>'
                    '<p>Sign into Yamtrack, then choose <b>Approve TV</b>.</p>'
                    '<button id="retry" hidden>Get a new code</button></div></div>'
                    '<script src="/__tv/qr.js"></script><script src="/__tv/pair.js"></script>')

    @app.post("/__tv/start")
    def start_pairing():
        key = device_key()
        with state.lock:
            state.clean()
            if key in state.devices:
                return jsonify(ready=True)
            for code, pending in state.pending.items():
                if pending["device"] == key:
                    return jsonify(code=code, expires=pending["expires"])
            # Bound memory even if another LAN client repeatedly requests codes.
            if len(state.pending) >= 64:
                return "Too many pending TVs. Try again in ten minutes.", 429
            ip = request.remote_addr
            stamp, count = state.issued.get(ip, (time.time(), 0))
            if count >= ISSUE_LIMIT:
                return "Too many new TV codes from this address. Try again in ten minutes.", 429
            state.issued[ip] = (stamp, count + 1)
            token = secrets.token_urlsafe(32)
            code = "%06d" % secrets.randbelow(1000000)
            while code in state.pending:
                code = "%06d" % secrets.randbelow(1000000)
            expires = time.time() + TTL
            state.pending[code] = {"device": digest(token), "expires": expires, "phone": None}
        return set_cookie(jsonify(code=code, expires=expires), DEVICE_COOKIE, token, 365 * 86400)

    @app.get("/__tv/status")
    def pairing_status():
        key = device_key()
        with state.lock:
            state.clean()
            ready = key in state.devices
            waiting = any(pair["device"] == key for pair in state.pending.values())
        return jsonify(ready=ready, expired=not ready and not waiting)

    login_url = LOGIN_PATH + "?" + urlencode({"next": "/__tv/approve"})

    def pending_phone():
        token = request.cookies.get(PAIR_COOKIE)
        if not token:
            return None
        phone_key = digest(token)
        return next((item for item in state.pending.values()
                     if item["phone"] == phone_key and item["expires"] > time.time()), None)

    @app.get("/__tv/pair")
    def pairing_form():
        code = request.args.get("code", "")
        scanned_code = code if re.fullmatch(r"[0-9]{6}", code) else ""
        return page("Connect your TV", '<form method="post" action="/__tv/pair"><label for="code">Code shown on the TV</label>'
                    '<input name="code" id="code" inputmode="numeric" pattern="[0-9 ]{6,7}" '
                    'autocomplete="one-time-code" value="' + scanned_code + '" required autofocus>'
                    '<button>Continue to Yamtrack login</button></form>')

    @app.post("/__tv/pair")
    def submit_pairing():
        code = request.form.get("code", "").replace(" ", "").strip()
        with state.lock:
            state.clean()
            ip = request.remote_addr
            stamp, count = state.attempts.get(ip, (time.time(), 0))
            state.attempts[ip] = (stamp, count + 1)
            if count >= 5:
                return page("Try again shortly", "<p>Please wait a minute before trying another code.</p>", 429)
            pending = state.pending.get(code)
            if not pending:
                return page("Code expired or incorrect",
                            '<p>Check the TV and try again.</p><a href="/__tv/pair">Enter code</a>', 400)
            if pending["phone"] is not None:
                if pending is pending_phone():
                    return redirect(login_url, 303)
                return page("Code already claimed", "<p>Continue pairing in the original browser.</p>", 409)
            token = secrets.token_urlsafe(32)
            pending["phone"] = digest(token)
        return set_cookie(redirect(login_url, 303), PAIR_COOKIE, token, TTL)

    @app.route("/__tv/approve", methods=["GET", "POST"])
    @limit_upstream
    def approve_tv():
        token = request.cookies.get(PAIR_COOKIE, "")
        phone_key = digest(token)
        with state.lock:
            state.clean()
            pair = pending_phone()
        if pair is None:
            return page("Pairing expired", '<a href="/__tv/pair">Enter the TV code again</a>', 400)
        if request.method == "POST" and not secrets.compare_digest(
            request.form.get("nonce", "").encode(), token.encode()
        ):
            return "Invalid approval.", 403
        upstream_cookies = {key: request.cookies[key] for key in COOKIES if key in request.cookies}
        if not upstream_cookies.get("sessionid"):
            return redirect(login_url, 303)
        probe_headers = {"Host": upstream.netloc, "Accept-Encoding": "identity"}
        anonymous, anonymous_headers, _ = probe_upstream("GET", "/", probe_headers)
        if not requires_login(anonymous, anonymous_headers):
            return page("Could not verify login", "<p>The Yamtrack homepage must require sign-in.</p>", 502)
        status, headers, _ = probe_upstream("GET", "/", {
            **probe_headers, "Cookie": cookie_header(upstream_cookies)
        })
        if status in (301, 302, 303, 307, 308, 401, 403):
            return redirect(login_url, 303)
        if status != 200:
            return page("Could not verify login", '<p>Yamtrack did not confirm your login. Try again.</p>', 502)
        excluded = connection_headers([value for header, value in headers if header.lower() == "connection"])
        for header, value in headers:
            if header.lower() == "set-cookie" and "set-cookie" not in excluded:
                upstream_cookies.update(cookie_values(value))
        if not upstream_cookies.get("sessionid"):
            return redirect(login_url, 303)
        if request.method != "POST":
            return page("Approve this TV", '<p>The TV showing your code will use this Yamtrack account.</p>'
                        '<form method="post"><input type="hidden" name="nonce" value="' + html.escape(token)
                        + '"><button>Approve TV</button></form>')
        with state.lock:
            # Check again after the upstream request in case the code expired or was reissued.
            if pair["phone"] != phone_key or not any(
                item is pair and item["expires"] > time.time() for item in state.pending.values()
            ):
                return "Pairing expired. Enter a new TV code.", 400
            state.commit_device(pair["device"], None,
                                {key: value for key, value in upstream_cookies.items() if value})
            state.pending = {code: item for code, item in state.pending.items() if item is not pair}
        return set_cookie(page("Your TV is connected", '<p>You can return to the TV. No password was saved.</p>'),
                          PAIR_COOKIE, "", 0)

    @app.route("/", defaults={"path": ""}, methods=["GET", "POST"])
    @app.route("/<yamtrack:path>", methods=["GET", "POST"])
    def forward(path):
        key = device_key()
        target = request_target().partition("?")[0]
        with state.lock:
            paired = key in state.devices
            phone = pending_phone() is not None
        if paired:
            return forward_upstream(key)
        if phone and (target == LOGIN_PATH or
                      (request.method in ("GET", "HEAD") and LOGIN_ASSET.fullmatch(target))):
            return forward_upstream()
        if DEVICE_COOKIE in request.cookies or target == "/":
            return redirect("/__tv/", 303)
        return "TV pairing required.", 403

    @limit_upstream
    def forward_upstream(key=None):
        return proxy(upstream, public_url, state, upstream_request, key)

    return app


def main():
    from waitress import serve

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    bind = os.environ.get("TV_BIND", "0.0.0.0")
    port = int(os.environ.get("TV_PORT", "8765"))
    # Proxy requests hold a worker while waiting for Yamtrack. Leave room for a
    # browser's parallel asset requests and other work during page loads.
    try:
        threads = int(os.environ.get("TV_THREADS", "8"))
        if threads < 1:
            raise ValueError
    except ValueError:
        raise SystemExit("TV_THREADS must be a positive integer.") from None
    try:
        app = create_app(upstream_slots=max(1, threads - 2))
    except ValueError as error:
        raise SystemExit(str(error)) from None
    if not access_log.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(message)s"))
        access_log.addHandler(handler)
    access_log.setLevel(logging.INFO)
    access_log.propagate = False
    serve(app, host=bind, port=port, threads=threads, ident=SERVER_NAME, max_request_body_size=MAX_BODY,
          log_socket_errors=True)


if __name__ == "__main__":
    main()
