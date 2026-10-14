import json, sys, argparse
from PIL import Image, ImageDraw, ImageFont
from fontTools.ttLib import TTFont, TTCollection

ap = argparse.ArgumentParser()
ap.add_argument('src'); ap.add_argument('out')
ap.add_argument('--pane', action='store_true')
ap.add_argument('--rows', type=int, default=0)
ap.add_argument('--scrub', action='store_true')
a = ap.parse_args()

SCALE = 2
CW, CH, SIZE = 9 * SCALE, 20 * SCALE, 15 * SCALE
F = '/System/Library/Fonts/'
SOURCES = [
    (F + 'Menlo.ttc', 0, 1),
    (F + 'AppleSDGothicNeo.ttc', 0, 6),
    (F + 'ヒラギノ角ゴシック W3.ttc', 0, None),
    (F + 'Apple Braille.ttf', 0, None),
    (F + 'Supplemental/EuphemiaCAS.ttc', 0, None),
    (F + 'Apple Symbols.ttf', 0, None),
    (F + 'Supplemental/Arial Unicode.ttf', 0, None),
]
fonts = []
for path, idx, bold_idx in SOURCES:
    try:
        tt = TTCollection(path).fonts[idx] if path.endswith('.ttc') else TTFont(path)
        cmap = tt.getBestCmap() or {}
        reg = ImageFont.truetype(path, SIZE, index=idx)
        bold = ImageFont.truetype(path, SIZE, index=bold_idx) if bold_idx is not None else None
        fonts.append((set(cmap), reg, bold))
    except Exception as e:
        print('skip', path, e, file=sys.stderr)

def font_for(ch, bold):
    cp = ord(ch)
    for cmap, reg, b in fonts:
        if cp in cmap:
            return (b or reg), (bold and b is None)
    return fonts[0][1], False

NAMED = {'black': (0,0,0), 'red': (205,49,49), 'green': (13,188,121), 'brown': (229,229,16), 'yellow': (229,229,16), 'blue': (36,114,200), 'magenta': (188,63,188), 'cyan': (17,168,205), 'white': (229,229,229)}
DFG, DBG = (212,212,212), (24,26,31)
def color(v, d):
    if v == 'default': return d
    if v in NAMED: return NAMED[v]
    try: return tuple(int(v[i:i+2], 16) for i in (0,2,4))
    except Exception: return d

data = json.load(open(a.src))
rows, cols = len(data), len(data[0])
if a.scrub:
    for row in data:
        if sum(1 for c in row if c[0] == '─') > cols * 0.6:
            for c in row:
                if c[0] not in ('─', ' ', ''):
                    c[0] = '─'
                elif c[0] == '':
                    c[0] = '─'
x0, x1, y0, y1 = 0, cols, 0, rows
if a.pane:
    counts = {}
    for row in data:
        for x, c in enumerate(row):
            if c[0] == '│': counts[x] = counts.get(x, 0) + 1
    div = max(counts, key=counts.get)
    x0 = div + 1
    y0 = 1
    for y, row in enumerate(data):
        if y > 2 and sum(1 for c in row if c[0] == '─') > cols * 0.6:
            y1 = y - 1; break
if a.rows: y1 = min(y1, y0 + a.rows)
W, H = (x1 - x0) * CW, (y1 - y0) * CH
img = Image.new('RGB', (W, H), DBG); dr = ImageDraw.Draw(img)
BLOCKS = {'▄': (0.5, 1), '▀': (0, 0.5), '█': (0, 1), '▆': (0.25, 1)}
for y in range(y0, y1):
    line = data[y]
    for x in range(x0, x1):
        c, fg, bg, bold, rev = line[x]
        f, b = color(fg, DFG), color(bg, DBG)
        if rev: f, b = b, f
        px, py = (x - x0) * CW, (y - y0) * CH
        dr.rectangle([px, py, px + CW - 1, py + CH - 1], fill=b)
    for x in range(x0, x1):
        c, fg, bg, bold, rev = line[x]
        if not c or c == ' ': continue
        f, b = color(fg, DFG), color(bg, DBG)
        if rev: f, b = b, f
        px, py = (x - x0) * CW, (y - y0) * CH
        if c in BLOCKS:
            t, btm = BLOCKS[c]
            dr.rectangle([px, py + int(CH * t), px + CW - 1, py + int(CH * btm) - 1], fill=f); continue
        if c in '│─╭╮╰╯':
            mx, my = px + CW // 2, py + CH // 2; w = max(1, SCALE)
            if c in '│': dr.rectangle([mx, py, mx + w - 1, py + CH - 1], fill=f)
            elif c == '─': dr.rectangle([px, my, px + CW - 1, my + w - 1], fill=f)
            else:
                horiz = (mx, px + CW - 1) if c in '╭╰' else (px, mx)
                vert = (my, py + CH - 1) if c in '╭╮' else (py, my)
                dr.rectangle([horiz[0], my, horiz[1], my + w - 1], fill=f)
                dr.rectangle([mx, vert[0], mx + w - 1, vert[1]], fill=f)
            continue
        wide = x + 1 < x1 and line[x + 1][0] == ''
        font, fake_bold = font_for(c[0], bold)
        box = font.getbbox(c)
        cw = CW * (2 if wide else 1)
        tx = px + (cw - (box[2] - box[0])) / 2 - box[0] if (wide or c[0] in 'ᓚᘏᗢ⠂⋅∘') else px
        ty = py + (CH - SIZE) / 2 - SCALE
        dr.text((tx, ty), c, font=font, fill=f)
        if fake_bold: dr.text((tx + 1, ty), c, font=font, fill=f)
img.save(a.out)
print(a.out, img.size)
