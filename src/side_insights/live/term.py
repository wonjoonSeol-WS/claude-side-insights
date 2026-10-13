"""Drawing helpers for the terminal panel: display width, wrapping, truecolor, badges and boxes."""
import re
import unicodedata

RESET, BOLD = "\033[0m", "\033[1m"
ANSI = re.compile(r"\033\[[0-9;]*m")
BULLET = re.compile(r"^[-•*]\s+")
NO_LINE_START = set("。、，．）」』】！？ー.,)!?:;")
MARKUP = re.compile(r"==(.+?)==|(?<![A-Za-z0-9_/*])\*\*(?=\S)(.+?)(?<=\S)\*\*(?![A-Za-z0-9_/*])|`([^`]+)`")
CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")
TAB_SIZE = 4
PAD_X = 2

TEXT = (225, 228, 234)
MUTED = (150, 156, 168)
FAINT = (98, 104, 116)
LINE = (62, 67, 78)
BLUE = (96, 150, 250)
GREEN = (79, 191, 127)
ORANGE = (231, 163, 62)
RED = (229, 96, 79)
PURPLE = (170, 130, 240)
TEAL = (64, 190, 190)
YELLOW = (240, 200, 90)
CODE = (165, 190, 255)
BASE = (24, 26, 31)
CODE_BG = (32, 35, 42)
SELECTED_BG = (44, 50, 64)
HIGHLIGHT_BG = (84, 70, 22)
KEY_BG = (56, 60, 72)
TINT = 0.25


def fg(rgb):
    return "\033[38;2;{};{};{}m".format(*rgb)


def bg(rgb):
    return "\033[48;2;{};{};{}m".format(*rgb)


def tint(rgb, amount=TINT):
    return tuple(round(b + (c - b) * amount) for c, b in zip(rgb, BASE))


def clean(text):
    """Text from transcripts and files may carry escape sequences; only printable characters reach the terminal."""
    return CONTROL.sub("", (text or "").expandtabs(TAB_SIZE))


def width(text):
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 0 if unicodedata.combining(c) else 1 for c in text)


def visible_width(line):
    return width(ANSI.sub("", line))


def pad(line, cols):
    return line + " " * max(0, cols - visible_width(line))


def _cut(chars, limit):
    out, used = [], 0
    for c in chars:
        if used + width(c) > limit:
            break
        out.append(c)
        used += width(c)
    return out, used


def fit(text, cols):
    text = clean(text)
    if cols <= 0:
        return ""
    if width(text) <= cols:
        return text + " " * (cols - width(text))
    out, used = _cut(text, cols - 1)
    return "".join(out) + "…" + " " * (cols - used - 1)


def fit_left(text, cols):
    text = clean(text)
    if cols <= 0:
        return ""
    if width(text) <= cols:
        return text + " " * (cols - width(text))
    out, used = _cut(reversed(text), cols - 1)
    return "…" + "".join(reversed(out)) + " " * (cols - used - 1)


def paint(text, color, background=None, bold=False):
    return (BOLD if bold else "") + fg(color) + (bg(background) if background else "") + text + RESET


def badge(text, color):
    return paint(f" {text} ", color, tint(color), bold=True)


def key_cap(text):
    return paint(f" {text} ", TEXT, KEY_BG, bold=True)


def _styled_chars(text):
    """(char, style) pairs; ==x== is a highlight, **x** bold, `x` code."""
    text, out, pos = clean(text), [], 0
    for m in MARKUP.finditer(text):
        out += [(c, None) for c in text[pos:m.start()]]
        style, inner = ("highlight", m.group(1)) if m.group(1) is not None else ("bold", m.group(2)) if m.group(2) is not None else ("code", m.group(3))
        out += [(c, style) for c in inner.replace("`", "").replace("**", "")]
        pos = m.end()
    return out + [(c, None) for c in text[pos:]]


def _breaks_anywhere(c):
    """Chinese and Japanese text has no spaces between words, so it may break between any two characters."""
    code = ord(c)
    return 0x3040 <= code <= 0x30FF or 0x3400 <= code <= 0x9FFF or 0xFF00 <= code <= 0xFFEF


def _break(chars, cols):
    """Breaks at the last space unless the moved word is long or Chinese/Japanese; never starts a line with a space or closing punctuation."""
    lines, line, used = [], [], 0
    for item in chars:
        w = width(item[0])
        if used + w > cols and line:
            cut = max((i for i, (c, _) in enumerate(line) if c == " "), default=-1)
            word = [c for c, _ in line[cut + 1:]] + [item[0]]
            if cut > 0 and not any(_breaks_anywhere(c) for c in word) and len(word) < cols // 2:
                lines.append(line[:cut])
                line = line[cut + 1:]
            elif item[0] in NO_LINE_START and len(line) > 1:
                lines.append(line[:-1])
                line = line[-1:]
            else:
                lines.append(line)
                line = []
            used = sum(width(c) for c, _ in line)
        if not line and item[0] == " ":
            continue
        line.append(item)
        used += w
    lines.append(line)
    return [list(reversed(list(_rstrip(reversed(l))))) for l in lines]


def _rstrip(items):
    items = iter(items)
    for item in items:
        if item[0] != " ":
            yield item
            yield from items
            return


def _render(line, color, bold=False):
    styles = {None: (BOLD if bold else "") + fg(color), "bold": BOLD + fg(TEXT), "code": fg(CODE), "highlight": fg(YELLOW) + bg(HIGHLIGHT_BG)}
    out, current = [], object()
    for c, style in line:
        if style != current:
            out.append(RESET + styles[style])
            current = style
        out.append(c)
    return "".join(out) + RESET


def styled(text, cols, color=TEXT, indent=0, bold=False):
    lines = []
    for paragraph in (text or "").split("\n"):
        lines += [" " * indent + _render(line, color, bold) for line in _break(_styled_chars(paragraph), max(1, cols - indent))]
    return lines


def bullets(text, cols, color=TEXT):
    out = []
    for line in (text or "").split("\n"):
        line = BULLET.sub("", line.strip())
        if line:
            wrapped = styled(line, cols, color, indent=2)
            out += [paint("• ", FAINT) + wrapped[0][2:], *wrapped[1:]]
    return out


def inner_width(cols):
    return cols - 2 - 2 * PAD_X


def box(lines, cols, color=LINE, title=""):
    """Rounded box with one empty line above and below the content and PAD_X spaces on each side."""
    inner = inner_width(cols)
    if visible_width(title) > cols - 5:
        title = paint(fit(ANSI.sub("", title), cols - 5).rstrip(), color, bold=True)
    head = paint("╭─ ", color) + title + " " + paint("─" * max(0, cols - visible_width(title) - 5) + "╮", color) if title \
        else paint("╭" + "─" * (cols - 2) + "╮", color)
    side = paint("│", color)
    gap = " " * PAD_X
    body = [f"{side}{gap}{pad(line, inner)}{gap}{side}" for line in ["", *lines, ""]]
    return [head, *body, paint("╰" + "─" * (cols - 2) + "╯", color)]
