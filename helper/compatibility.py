"""Adapt Yamtrack responses for the LG CX browser."""
import hashlib
from pathlib import Path
import re

from .legacy_css import lower_css


FONT_LINKS = ('<link rel="preload" href="/__tv/fonts/roboto-flex-3.2-400.woff" '
              'as="font" type="font/woff" crossorigin>'
              '<link rel="stylesheet" href="/__tv/fonts.css">')


# Chromium 68 cannot parse optional chaining or nullish coalescing. Limit the
# rewrites to the expressions in Yamtrack's Alpine bundle and tracker date handler.
ALPINE_REWRITES = {
    b"e._x_effects?.forEach(Wt)": b"e._x_effects && e._x_effects.forEach(Wt)",
    b"e._x_cleanups?.length": b"e._x_cleanups && e._x_cleanups.length",
    b"o?.set&&o?.get": b"o&&o.set&&o.get",
    b'e??{message:"No error message given."}': b'e==null?{message:"No error message given."}:e',
    b"([u])=>u?.()": b"([u])=>u==null?void 0:u()",
}


def rewrite_html(body):
    scripts = (FONT_LINKS.encode() + b'<link rel="stylesheet" href="/__tv/compat.css">'
               b'<link rel="stylesheet" href="/__tv/client.css">'
               b'<script defer src="/__tv/client.js"></script>'
               b'<script defer src="/__tv/navigation.js"></script>')
    # HTMX returns HTML fragments too; inject only into full documents.
    head = re.search(rb"<head(?:\s[^>]*)?>", body, re.I)
    closing_head = re.search(rb"</head\s*>", body, re.I)
    if head and closing_head and head.end() <= closing_head.start():
        compat = (b'<style>html{background:#212529;color:#edf2fa}</style>'
                  b'<script src="/__tv/compat.js"></script>')
        body = (body[:head.end()] + compat + body[head.end():closing_head.start()]
                + scripts + body[closing_head.start():])
    return body


def rewrite_script(path, body):
    if path == "/static/js/libraries/chartjs-4.4.9.min.js":
        # The upstream UMD bundle uses public class fields, which Chromium 68 cannot parse.
        return (Path(__file__).parent / "static/vendor/chartjs-4.4.9.chrome68.min.js").read_bytes()
    if path == "/static/js/libraries/alpinejs-3.14.9.min.js":
        for modern, legacy in ALPINE_REWRITES.items():
            body = body.replace(modern, legacy)
    elif path == "/static/js/mediaStatusDateHandler.js":
        body = re.sub(rb"\b(statusField|startDateField|endDateField)\?\.value",
                      rb"(\1 == null ? undefined : \1.value)", body)
    elif path == "/static/js/date-range.js":
        body = body.replace(b"scriptTag?.dataset.dateFormat", b"scriptTag && scriptTag.dataset.dateFormat")
        body = body.replace(b"!formatsElement?.textContent", b"!formatsElement || !formatsElement.textContent")
        body = body.replace(b"catch {", b"catch (error) {")
        body = body.replace(b"formatters[character]?.() ?? character",
                            b"(formatters[character] ? formatters[character]() : character)")
        body = body.replace(b"window.location.href = url.toString();", (
            b"if (document.dispatchEvent(new CustomEvent('ytv:navigate', "
            b"{ detail:url.href, cancelable:true }))) window.location.href = url.href;"
        ))
    elif path in ("/static/js/statistics-charts.js", "/static/js/copy-item.js"):
        body = body.replace(b'document.addEventListener("DOMContentLoaded", function () {',
                            b'window.ytvOnPage(function () {', 1)
        if path.endswith("statistics-charts.js"):
            body = body.replace(b"Chart.register(ChartDataLabels);", (
                b"if (!window.Chart || !window.ChartDataLabels || "
                b"!document.getElementById('media_type_distribution')) return;\n"
                b"Chart.register(ChartDataLabels);\n"
                b"Chart.defaults.font.family = getComputedStyle(document.documentElement).fontFamily;\n"
                b"if (document.fonts) document.fonts.load('12px ' + Chart.defaults.font.family).then(function () {\n"
                b"  Object.values(Chart.instances).forEach(function (chart) { chart.update('none'); });\n"
                b"}, function () {});"
            ), 1)
            body += (b"\ndocument.addEventListener('ytv:before-page', function () {"
                     b"if (window.Chart) Object.values(Chart.instances).forEach(function (chart) { chart.destroy(); });"
                     b"});\n")
    return body


def rewrite_response(path, body, content_type, state):
    if "text/html" in content_type:
        return rewrite_html(body)
    if "javascript" in content_type:
        return rewrite_script(path, body)
    if "text/css" in content_type and b"@layer" in body:
        key = hashlib.sha256(body).hexdigest()
        with state.lock:
            lowered = state.css_cache.get(key)
        if lowered is None:
            lowered = lower_css(body.decode("utf-8")).encode()
            with state.lock:
                if len(state.css_cache) > 8:
                    state.css_cache.clear()
                state.css_cache[key] = lowered
        body = lowered
    return body
