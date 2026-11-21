"""Flask routes for LAN-only Yamtrack pairing and TV proxying."""
from functools import partial
import hashlib
import html
import http.client
import json
import os
from pathlib import Path
import re
import secrets
import threading
import time
from urllib.parse import urlencode, urlsplit

from flask import Flask, Response, jsonify, redirect, request, send_from_directory
from werkzeug.routing import PathConverter

from .proxy import cookie_header, cookie_values, proxy, request_upstream

STATIC = Path(__file__).parent / "static"
DEVICE_COOKIE = "ytv_device"
PAIR_COOKIE = "ytv_pair"
TTL = 600
MAX_BODY = 4 * 1024 * 1024
SERVER_NAME = "YamtrackTV/0.1.16"


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


class State:
    def __init__(self, path):
        self.path = Path(path) if path else None
        self.lock = threading.RLock()
        self.devices = {}
        self.pending = {}
        self.attempts = {}
        self.css_cache = {}
        if self.path and self.path.exists():
            self.devices = json.loads(self.path.read_text())

    def save(self):
        if not self.path:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as target:
            json.dump(self.devices, target)
        temporary.replace(self.path)

    def clean(self):
        now = time.time()
        self.pending = {k: v for k, v in self.pending.items() if v["expires"] > now}
        self.attempts = {k: v for k, v in self.attempts.items() if v[0] > now - 60}


def page(title, body, status=200):
    return Response(
        '<!doctype html><html lang="en"><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '<title>' + html.escape(title) + '</title>' + '<link rel="stylesheet" href="/__tv/pair.css">'
        '<main><p class="eyebrow">YAMTRACK TV</p><h1>' + html.escape(title) + '</h1>'
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
        parsed = urlsplit(referer)
        return parsed.scheme + "://" + parsed.netloc == public_url
    return request.headers.get("Sec-Fetch-Site") not in ("cross-site", "same-site")


class YamtrackPath(PathConverter):
    regex = r"(?!__tv/)[^/].*?"


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


def create_app(upstream_url=None, public_url=None, state_path=None, *, upstream_request=None):
    if state_path is None:
        state_path = os.environ.get("TV_STATE", "data/sessions.json")
    upstream = configured_origin("YAMTRACK_URL", upstream_url)
    public = configured_origin("TV_PUBLIC_URL", public_url)
    public_url = public.geturl()

    app = Flask(__name__, static_folder=None)
    app.config["MAX_CONTENT_LENGTH"] = MAX_BODY
    app.url_map.merge_slashes = False
    app.url_map.converters["yamtrack"] = YamtrackPath
    app.logger.disabled = True  # Request URLs can contain pairing codes or calendar tokens.
    state = State(state_path)
    app.extensions["yamtrack_tv_state"] = state
    if upstream_request is None:
        upstream_request = partial(request_upstream, upstream)

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
        response.headers.update({
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "same-origin",
            "X-Frame-Options": "DENY",
        })
        return response

    def unavailable(_error):
        return page("Yamtrack is unavailable",
                    '<p>Check that Yamtrack is running at ' + html.escape(upstream.geturl())
                    + '.</p><a href="/">Try again</a>', 502)

    app.register_error_handler(OSError, unavailable)
    app.register_error_handler(http.client.HTTPException, unavailable)

    @app.get("/__tv/<any(pair.css,pair.js,qr.js,client.css,client.js,compat.js,navigation.js):filename>")
    def static_asset(filename):
        mime = "text/css" if filename.endswith(".css") else "application/javascript"
        response = send_from_directory(STATIC, filename, mimetype=mime, conditional=False, etag=False)
        response.content_type = mime
        return response

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

    login_url = "/accounts/login/?" + urlencode({"next": "/__tv/approve"})

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
            token = secrets.token_urlsafe(32)
            pending["phone"] = digest(token)
        return set_cookie(redirect(login_url, 303), PAIR_COOKIE, token, TTL)

    @app.route("/__tv/approve", methods=["GET", "POST"])
    def approve_tv():
        token = request.cookies.get(PAIR_COOKIE, "")
        phone_key = digest(token)
        with state.lock:
            state.clean()
            pair = next((item for item in state.pending.values() if item["phone"] == phone_key), None)
        if pair is None:
            return page("Pairing expired", '<a href="/__tv/pair">Enter the TV code again</a>', 400)
        upstream_cookies = {k: v for k, v in request.cookies.items() if not k.startswith("ytv_")}
        status, headers, _ = upstream_request("GET", "/", {
            "Host": upstream.netloc, "Cookie": cookie_header(upstream_cookies), "Accept-Encoding": "identity"
        })
        if status in (301, 302, 303, 307, 308, 401, 403):
            return redirect(login_url, 303)
        if status != 200:
            return page("Could not verify login", '<p>Yamtrack did not confirm your login. Try again.</p>', 502)
        if "sessionid" not in upstream_cookies:
            return page("No Yamtrack session", '<p>This helper expects Django’s default sessionid cookie.</p>', 400)
        for header, value in headers:
            if header.lower() == "set-cookie":
                upstream_cookies.update(cookie_values(value))
        if request.method != "POST":
            return page("Approve this TV", '<p>The TV showing your code will use this Yamtrack account.</p>'
                        '<form method="post"><input type="hidden" name="nonce" value="' + html.escape(token)
                        + '"><button>Approve TV</button></form>')
        if not secrets.compare_digest(request.form.get("nonce", "").encode(), token.encode()):
            return "Invalid approval.", 403
        with state.lock:
            # Check again after the upstream request in case the code expired or was reissued.
            if pair["phone"] != phone_key or not any(
                item is pair and item["expires"] > time.time() for item in state.pending.values()
            ):
                return "Pairing expired. Enter a new TV code.", 400
            state.devices[pair["device"]] = upstream_cookies
            state.pending = {code: item for code, item in state.pending.items() if item is not pair}
            state.save()
        return set_cookie(page("Your TV is connected", '<p>You can return to the TV. No password was saved.</p>'),
                          PAIR_COOKIE, "", 0)

    @app.route("/", defaults={"path": ""}, methods=["GET", "POST"])
    @app.route("/<yamtrack:path>", methods=["GET", "POST"])
    def forward(path):
        return proxy(upstream, public_url, state, upstream_request,
                     DEVICE_COOKIE in request.cookies, device_key())

    return app


def main():
    from waitress import serve

    bind = os.environ.get("TV_BIND", "0.0.0.0")
    port = int(os.environ.get("TV_PORT", "8765"))
    try:
        app = create_app()
    except ValueError as error:
        raise SystemExit(str(error)) from None
    serve(app, host=bind, port=port, ident=SERVER_NAME, max_request_body_size=MAX_BODY,
          log_socket_errors=False)


if __name__ == "__main__":
    main()
