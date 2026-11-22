"""Forward authenticated TV requests through the configured Yamtrack origin."""
import http.client
from http.cookies import SimpleCookie
import re
import time
from urllib.parse import quote, urlsplit

from flask import Response, abort, redirect, request

from .compatibility import rewrite_response

HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
       "te", "trailer", "trailers", "transfer-encoding", "upgrade", "content-length"}
COOKIES = {"sessionid", "csrftoken", "messages"}
REQUEST_HEADERS = {
    "accept", "accept-language", "content-type", "origin", "referer", "user-agent",
    "range", "if-range", "x-csrftoken", "x-requested-with", "hx-boosted", "hx-current-url",
    "hx-history-restore-request", "hx-prompt", "hx-request", "hx-target", "hx-trigger", "hx-trigger-name",
}
MAX_RESPONSE = 16 * 1024 * 1024
UPSTREAM_TIMEOUT = 15


class UpstreamBusy(Exception):
    pass


def connection_headers(values):
    return HOP | {name.strip().lower() for value in values for name in value.split(",")}


def cookie_values(text):
    jar = SimpleCookie()
    try:
        jar.load(text)
    except Exception:
        return {}
    if len(jar) != 1:
        return {}
    return {key: val.value for key, val in jar.items() if key in COOKIES}


def cookie_header(values):
    jar = SimpleCookie()
    for key in sorted(values.keys() & COOKIES):
        jar[key] = values[key]
    return "; ".join(m.OutputString() for m in jar.values())


def request_upstream(upstream, method, target, headers, body=None, *, read_body=True):
    connection_type = http.client.HTTPSConnection if upstream.scheme == "https" else http.client.HTTPConnection
    connection = connection_type(upstream.hostname, upstream.port, timeout=UPSTREAM_TIMEOUT)
    deadline = time.monotonic() + UPSTREAM_TIMEOUT
    try:
        connection.request(method, target, body=body, headers=headers)
        sock = connection.sock
        sock.settimeout(max(0.001, deadline - time.monotonic()))
        with connection.getresponse() as response:
            if not read_body:
                return response.status, response.getheaders(), b""
            if method != "HEAD" and response.length is not None and response.length > MAX_RESPONSE:
                raise http.client.HTTPException("Upstream response exceeds size limit")
            body = bytearray()
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("Upstream response exceeded its deadline")
                sock.settimeout(remaining)
                chunk = response.read1(min(64 * 1024, MAX_RESPONSE + 1 - len(body)))
                if not chunk:
                    if response.length:
                        raise http.client.IncompleteRead(bytes(body), response.length)
                    return response.status, response.getheaders(), bytes(body)
                body.extend(chunk)
                if len(body) > MAX_RESPONSE:
                    raise http.client.HTTPException("Upstream response exceeds size limit")
    finally:
        connection.close()


def request_target():
    # Waitress supplies the original target, including escaped path and query.
    target = request.environ.get("REQUEST_URI") or request.environ.get("RAW_URI")
    if target is None:
        target = quote(request.path, safe="/:@!$&'()*+,;=-._~")
        if request.query_string:
            target += "?" + request.query_string.decode("latin-1")
    return target


def origin_of(value):
    try:
        parsed = urlsplit(value)
    except ValueError:
        return ""
    return f"{parsed.scheme}://{parsed.netloc}" if parsed.scheme and parsed.netloc else ""


def proxy(upstream, public_url, state, upstream_request, device_key=None):
    target = request_target()
    if not target.startswith("/") or target.startswith("//"):
        abort(400)
    is_tv = device_key is not None
    if is_tv:
        with state.lock:
            session = state.devices.get(device_key, {})
        if not session.get("sessionid"):
            return redirect("/__tv/", 303)
    else:
        session = {key: request.cookies[key] for key in COOKIES if key in request.cookies}
    allowed = REQUEST_HEADERS - connection_headers(request.headers.getlist("Connection"))
    headers = {key: value for key, value in request.headers.items() if key.lower() in allowed}
    headers["Host"] = upstream.netloc
    headers["Accept-Encoding"] = "identity"
    headers["Cookie"] = cookie_header(session)
    for name in ("Origin", "Referer"):
        if name in headers and origin_of(headers[name]) == public_url:
            headers[name] = upstream.scheme + "://" + upstream.netloc + headers[name][len(public_url):]
    status, response_headers, body = upstream_request(request.method, target, headers, request.get_data() or None)
    excluded = connection_headers([value for key, value in response_headers if key.lower() == "connection"])
    encoded = any(key.lower() == "content-encoding" and value.lower() != "identity"
                  for key, value in response_headers)
    outgoing = []
    content_type = "application/octet-stream"
    updated = dict(session)
    for key, value in response_headers:
        name = key.lower()
        if name in excluded:
            continue
        if name == "content-type":
            content_type = value
        elif name == "location":
            prefix = upstream.scheme + "://" + upstream.netloc
            if value.startswith(prefix + "/"):
                value = value[len(prefix):]
            elif value.startswith("//" + upstream.netloc + "/"):
                value = value[len(upstream.netloc)+2:]
            local_redirect = ((value.startswith("/") and not value.startswith("//")) or
                              origin_of(value) in (upstream.geturl(), public_url))
            if (is_tv and status in (301, 302, 303, 307, 308) and local_redirect and
                    urlsplit(value).path.rstrip("/") == "/accounts/login"):
                with state.lock:
                    current = state.devices.get(device_key)
                    if current is not None and current.get("sessionid") == session.get("sessionid"):
                        state.commit_device(device_key, current, None)
                return redirect("/__tv/", 303)
            outgoing.append((key, value))
        elif name == "set-cookie":
            values = cookie_values(value)
            if not values or not re.match(r"^(sessionid|csrftoken|messages)=", value):
                continue
            if is_tv:
                for ck, cv in values.items():
                    if cv:
                        updated[ck] = cv
                    else:
                        updated.pop(ck, None)
                # JS may need the CSRF cookie; the session stays at the helper.
                if not value.startswith("csrftoken="):
                    continue
            # Host-only cookies on the helper rather than a Domain for upstream.
            outgoing.append((key, re.sub(r";\s*Domain=[^;]+", "", value, flags=re.I)))
        elif name not in {"cache-control", "etag", "server", "date",
                                    "x-frame-options", "x-content-type-options", "referrer-policy"}:
            outgoing.append((key, value))
    if is_tv and updated != session:
        with state.lock:
            current = state.devices.get(device_key)
            # Apply only changes to cookies that have not since been replaced.
            if current is not None and current.get("sessionid") == session.get("sessionid"):
                merged = current.copy()
                for name in session.keys() | updated.keys():
                    if session.get(name) == updated.get(name) or current.get(name) != session.get(name):
                        continue
                    if name in updated:
                        merged[name] = updated[name]
                    else:
                        merged.pop(name, None)
                if merged != current:
                    state.commit_device(device_key, current, merged if merged.get("sessionid") else None)
    if is_tv:
        csrf = updated.get("csrftoken")
        if "text/html" in content_type and csrf and re.fullmatch(r"[A-Za-z0-9]+", csrf):
            secure = "; Secure" if public_url.startswith("https://") else ""
            outgoing.append(("Set-Cookie", "csrftoken=%s; Path=/; SameSite=Lax%s" % (csrf, secure)))
        if not encoded and status == 200 and request.method != "HEAD":
            body = rewrite_response(urlsplit(target).path, body, content_type, state)
    return Response(body, status=status, content_type=content_type, headers=outgoing)
