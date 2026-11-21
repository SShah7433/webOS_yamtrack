"""Lower the CSS features used by Yamtrack's Tailwind 4 for Chromium 68.

This is a focused adapter, not a general CSS transpiler. Original CSS remains
appropriate for phones; only the paired TV receives the lowered stylesheet.
"""
import math
import re


TRANSFORM_PARTS = ("translate", "rotate", "scale")
LEGACY_TRANSFORM = " ".join("var(--ytv-%s,)" % prop for prop in (*TRANSFORM_PARTS, "transform"))


def split_list(text):
    return [part for part, _ in tokens(text, ",") if part]


def tokens(source, delimiters=";{}"):
    """Yield declaration and block tokens without splitting quoted CSS values."""
    source = re.sub(r"/\*.*?\*/", "", source, flags=re.S)
    start = 0
    quote = None
    depth = 0
    escape = False
    for i, char in enumerate(source):
        if escape:
            escape = False
            continue
        if char == "\\":
            escape = True
            continue
        if quote:
            if char == quote:
                quote = None
            continue
        if char in "\"'":
            quote = char
        elif char in "([":
            depth += 1
        elif char in ")]":
            depth -= 1
        elif depth == 0 and char in delimiters:
            yield source[start:i].strip(), char
            start = i + 1
    if source[start:].strip():
        yield source[start:].strip(), ";"


def parse(source):
    stream = iter(tokens(source))

    def block():
        result = []
        for text, end in stream:
            if end == "}":
                if text:
                    result.append((text, None))
                break
            result.append((text, block() if end == "{" else None))
        return result
    return block()


def selectors(text):
    """Expand the simple :is/:where groups emitted by Tailwind."""
    # Group and peer variants put the current element at the end of a
    # complex selector. Preserve the combinator when flattening the rule.
    text = re.sub(r"&:is\(:where\((\.[\w-]+)\)(:[\w-]+\s+(?:~\s+)?)\*\)",
                  r"\1\2&", text)
    match = re.search(r":(?:is|where)\(((?:[^()]|\([^()]*\))*)\)", text)
    if match:
        result = []
        for part in split_list(match[1]):
            result.extend(selectors(text[:match.start()] + part + text[match.end():]))
        return result
    # Chromium 68 supports :not(), but not selector lists inside it.
    text = re.sub(r":not\(([^()]*,[^()]*)\)",
                  lambda m: "".join(":not(%s)" % s for s in split_list(m[1])), text)
    return split_list(text)


def oklch(match):
    light, chroma, hue = map(float, match.groups())
    light /= 100
    a = chroma * math.cos(math.radians(hue))
    b = chroma * math.sin(math.radians(hue))
    l = (light + 0.3963377774 * a + 0.2158037573 * b) ** 3
    m = (light - 0.1055613458 * a - 0.0638541728 * b) ** 3
    s = (light - 0.0894841775 * a - 1.2914855480 * b) ** 3
    linear = (4.0767416621*l - 3.3077115913*m + 0.2309699292*s,
              -1.2684380046*l + 2.6097574011*m - 0.3413193965*s,
              -0.0041960863*l - 0.7034186147*m + 1.7076147010*s)
    def channel(value):
        value = max(0, min(1, value))
        return round(255 * (12.92*value if value <= 0.0031308 else 1.055*value**(1/2.4)-0.055))
    return "rgb(%d,%d,%d)" % tuple(channel(c) for c in linear)


def values(text):
    text = re.sub(r"oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\)", oklch, text)
    def translucent(match):
        color, percent = match.groups()
        if color.startswith("#"):
            digits = color[1:]
            if len(digits) == 3:
                digits = "".join(digit * 2 for digit in digits)
            color = ",".join(str(int(digits[i:i+2], 16)) for i in (0, 2, 4))
        else:
            color = color[4:-1]
        return "rgba(%s,%g)" % (color, float(percent) / 100)

    text = re.sub(r"color-mix\(in srgb,\s*(#[\da-fA-F]{6}|#[\da-fA-F]{3}|rgb\([\d, ]+\))"
                  r"\s+([\d.]+)%,\s*transparent\)", translucent, text)
    text = re.sub(r"rgb\(([^(),]+)\)",
                  lambda m: ("rgba(" + ",".join(m[1].replace("/", " ").split()) + ")")
                  if "/" in m[1] else "rgb(" + ",".join(m[1].split()) + ")", text)
    # calc(1 / .75) and calc(.25rem * 4) use typed arithmetic newer than the TV.
    text = re.sub(r"calc\(([\d.]+)\s*/\s*([\d.]+)\)",
                  lambda m: str(float(m[1])/float(m[2])), text)
    text = re.sub(r"calc\(([\d.]+)\s*/\s*([\d.]+)\s*\*\s*100%\)",
                  lambda m: "%g%%" % (100*float(m[1])/float(m[2])), text)
    # Tailwind spacing is consistently 0.25rem. Resolve its multiplication.
    text = re.sub(r"calc\(var\(--spacing\)\s*\*\s*(-?[\d.]+)\)",
                  lambda m: "%grem" % (0.25*float(m[1])), text)
    text = re.sub(r"(?<=[\d.])(?:sv|lv|dv)([hw])\b", r"v\1", text)
    return text


def declaration(text):
    if ":" not in text:
        return ""
    name, value = text.split(":", 1)
    name, value = name.strip(), values(value.strip())
    logical = {
        "padding-inline": ("padding-left", "padding-right"),
        "padding-block": ("padding-top", "padding-bottom"),
        "margin-inline": ("margin-left", "margin-right"),
        "margin-block": ("margin-top", "margin-bottom"),
        "inset-inline": ("left", "right"), "inset-block": ("top", "bottom"),
        "padding-inline-start": ("padding-left",), "padding-inline-end": ("padding-right",),
        "margin-inline-start": ("margin-left",), "margin-inline-end": ("margin-right",),
        "margin-block-start": ("margin-top",), "margin-block-end": ("margin-bottom",),
        "inset-inline-start": ("left",), "inset-inline-end": ("right",),
        "inset-block-start": ("top",), "inset-block-end": ("bottom",),
    }
    if name in ("gap", "row-gap", "column-gap"):
        return "grid-%s:%s;%s:%s;" % (name, value, name, value)
    if name == "inset":
        parts = [part for part, _ in tokens(value, " \t\r\n") if part]
        if len(parts) == 1:
            parts *= 4
        elif len(parts) == 2:
            parts *= 2
        elif len(parts) == 3:
            parts.append(parts[1])
        return "".join("%s:%s;" % pair for pair in zip(("top", "right", "bottom", "left"), parts))
    if name in logical:
        parts = [part for part, _ in tokens(value, " \t\r\n") if part] if len(logical[name]) == 2 else [value]
        return "".join("%s:%s;" % pair for pair in zip(logical[name], parts * 2))
    if name.startswith("--tw-scale-") and re.fullmatch(r"[\d.]+%", value):
        value = "%g" % (float(value[:-1]) / 100)
    if name in TRANSFORM_PARTS:
        parts = [part for part, _ in tokens(value, " \t\r\n") if part]
        if name == "scale":
            parts = ["%g" % (float(part[:-1]) / 100) if re.fullmatch(r"[\d.]+%", part) else part for part in parts]
        if len(parts) <= (1 if name == "rotate" else 2):
            component = "initial" if value == "none" else "%s(%s)" % (name, ",".join(parts))
            return "--ytv-%s:%s;transform:%s;" % (name, component, LEGACY_TRANSFORM)
    if name == "transform" and value.startswith("var(--tw-rotate-x,"):
        return "--ytv-transform:%s;transform:%s;" % (value, LEGACY_TRANSFORM)
    if name == "opacity" and re.fullmatch(r"[\d.]+%", value):
        value = "%g" % (float(value[:-1]) / 100)
    if name == "border-radius" and value == "calc(infinity * 1px)":
        value = "9999px"
    return "%s:%s;" % (name, value)


def lower_css(source):
    defaults = {"--ytv-" + prop: "initial" for prop in (*TRANSFORM_PARTS, "transform")}

    def emit(nodes, parents=None):
        output = []
        pending = []

        def flush():
            if pending and parents:
                valid = [s for s in parents if not any(x in s for x in (
                    "::file-selector-button", "::backdrop", ":host", ":-moz-"))]
                if valid:
                    output.append(",".join(valid) + "{" + "".join(pending) + "}")
            pending.clear()

        for head, children in nodes:
            if children is None:
                if not head.startswith("@"):
                    pending.append(declaration(head))
                continue
            flush()
            if head.startswith("@property "):
                name = head[len("@property "):].strip()
                for prop, child in children:
                    if child is None and prop.startswith("initial-value:"):
                        defaults[name] = prop.split(":", 1)[1].strip()
            elif head.startswith("@layer"):
                output.append(emit(children, parents))
            elif head.startswith("@media"):
                head = re.sub(r"\(width\s*>=\s*([^)]+)\)", r"(min-width:\1)", head)
                head = re.sub(r"\(width\s*<\s*([\d.]+)(rem|px)\)",
                              lambda m: "(max-width:%g%s)" % (float(m[1])-0.001, m[2]), head)
                output.append(head + "{" + emit(children, parents) + "}")
            elif head.startswith("@supports"):
                output.append(head + "{" + emit(children, parents) + "}")
            elif head.startswith("@keyframes") or head.startswith("@font-face"):
                # Keep animation steps separate from surrounding selectors.
                if head.startswith("@font-face"):
                    output.append(head + "{" + "".join(declaration(t) for t, c in children if c is None) + "}")
                else:
                    output.append(head + "{" + emit(children) + "}")
            elif not head.startswith("@"):
                child_selectors = selectors(head)
                combined = child_selectors if not parents else [
                    child.replace("&", parent) if "&" in child else parent + " " + child
                    for parent in parents for child in child_selectors]
                output.append(emit(children, combined))
        flush()
        return "".join(output)

    result = emit(parse(source))
    initial = "*,::before,::after{" + "".join(declaration(k+":"+v) for k, v in defaults.items()) + "}"
    return initial + result
