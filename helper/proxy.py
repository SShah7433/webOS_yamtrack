"""Forward authenticated TV requests through the configured Yamtrack origin."""
import http.client
from http.cookies import SimpleCookie
import re
from urllib.parse import quote, urlsplit

from flask import Response, abort, redirect, request

from .compatibility import rewrite_response

HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
       "te", "trailer", "trailers", "transfer-encoding", "upgrade", "content-length"}


def cookie_values(text):
    jar = SimpleCookie()
    try:
        jar.load(text)
    except Exception:
        return {}
    return {key: val.value for key, val in jar.items()}


def cookie_header(values):
    jar = SimpleCookie()
    for key, value in values.items():
        jar[key] = value
    return "; ".join(m.OutputString() for m in jar.values())


def request_upstream(upstream, method, target, headers, body=None):
    connection_type = http.client.HTTPSConnection if upstream.scheme == "https" else http.client.HTTPConnection
    connection = connection_type(upstream.hostname, upstream.port, timeout=20)
    try:
        connection.request(method, target, body=body, headers=headers)
        response = connection.getresponse()
        return response.status, response.getheaders(), response.read()
    finally:
        connection.close()


def request_target():
    # Waitress supplies the original target, including escaped path and query.
    target = request.environ.get("REQUEST_URI") or request.environ.get("RAW_URI")
    if target is None:
        target = quote(request.path, safe="/:@!$&'()*+,;=-._~")
        if request.query_string:
            target += "?" + request.query_string.decode("latin-1")
    if not target.startswith("/") or target.startswith("//"):
        abort(400)
    return target


def proxy(upstream, public_url, state, upstream_request, is_tv, device_key):
    target = request_target()
    with state.lock:
        session = dict(state.devices.get(device_key, {}))
    if is_tv and not session:
        return redirect("/__tv/", 303)
    headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP | {
        "host", "cookie", "accept-encoding", "forwarded", "x-forwarded-host", "x-forwarded-proto",
        "if-none-match", "if-modified-since"}}
    headers["Host"] = upstream.netloc
    headers["Accept-Encoding"] = "identity"
    headers["Cookie"] = cookie_header(session if is_tv else {
        k: v for k, v in request.cookies.items() if not k.startswith("ytv_")})
    for name in ("Origin", "Referer"):
        if name in headers and headers[name].startswith(public_url):
            headers[name] = upstream.scheme + "://" + upstream.netloc + headers[name][len(public_url):]
    status, response_headers, body = upstream_request(request.method, target, headers, request.get_data() or None)
    outgoing = []
    content_type = "application/octet-stream"
    updated = dict(session)
    for key, value in response_headers:
        name = key.lower()
        if name == "content-type":
            content_type = value
        elif name == "location":
            prefix = upstream.scheme + "://" + upstream.netloc
            if value.startswith(prefix + "/"):
                value = value[len(prefix):]
            elif value.startswith("//" + upstream.netloc + "/"):
                value = value[len(upstream.netloc)+2:]
            if is_tv and urlsplit(value).path.rstrip("/") == "/accounts/login":
                with state.lock:
                    state.devices.pop(device_key, None)
                    state.save()
                return redirect("/__tv/", 303)
            outgoing.append((key, value))
        elif name == "set-cookie":
            if is_tv:
                for ck, cv in cookie_values(value).items():
                    if cv:
                        updated[ck] = cv
                    else:
                        updated.pop(ck, None)
                # JS may need the CSRF cookie; the session stays at the helper.
                if "csrftoken" not in cookie_values(value):
                    continue
            # Host-only cookies on the helper rather than a Domain for upstream.
            outgoing.append((key, re.sub(r";\s*Domain=[^;]+", "", value, flags=re.I)))
        elif name not in HOP | {"cache-control", "content-encoding", "etag", "server", "date",
                                    "x-frame-options", "x-content-type-options", "referrer-policy"}:
            outgoing.append((key, value))
    if is_tv and updated != session:
        with state.lock:
            # A late image/CSS response must not resurrect a logged-out device.
            if device_key in state.devices:
                state.devices[device_key].update({k: v for k, v in updated.items() if session.get(k) != v})
                for key in session.keys() - updated.keys():
                    state.devices[device_key].pop(key, None)
                state.save()
    if is_tv:
        if "text/html" in content_type and session.get("csrftoken"):
            csrf = updated.get("csrftoken", session["csrftoken"])
            outgoing.append(("Set-Cookie", "csrftoken=%s; Path=/; SameSite=Lax" % csrf))
        body = rewrite_response(urlsplit(target).path, body, content_type, state)
    return Response(body, status=status, content_type=content_type, headers=outgoing)
