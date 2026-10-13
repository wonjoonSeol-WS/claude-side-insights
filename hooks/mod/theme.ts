export type Rgb = readonly [number, number, number]

export type Palette = {
  dark: boolean
  base: Rgb
  card: Rgb
  code: Rgb
  line: Rgb
  text: Rgb
  muted: Rgb
  faint: Rgb
  blue: Rgb
  green: Rgb
  orange: Rgb
  red: Rgb
  purple: Rgb
  teal: Rgb
  yellow: Rgb
  pink: Rgb
  selected: Rgb
  key: Rgb
  hero: readonly Rgb[]
  heroText: Rgb
  cat: Rgb
}

export const DARK: Palette = {
  dark: true,
  base: [13, 17, 23],
  card: [21, 27, 35],
  code: [17, 19, 23],
  line: [61, 68, 77],
  text: [240, 246, 252],
  muted: [145, 152, 161],
  faint: [101, 108, 118],
  blue: [68, 147, 248],
  green: [63, 185, 80],
  orange: [219, 109, 40],
  red: [248, 81, 73],
  purple: [171, 125, 248],
  teal: [57, 197, 207],
  yellow: [210, 153, 34],
  pink: [219, 97, 162],
  selected: [18, 29, 47],
  key: [38, 44, 54],
  hero: [
    [130, 80, 223],
    [9, 105, 218],
    [27, 124, 131],
    [26, 127, 55],
  ],
  heroText: [255, 255, 255],
  cat: [255, 210, 120],
}

export const LIGHT: Palette = {
  dark: false,
  base: [246, 248, 250],
  card: [255, 255, 255],
  code: [234, 236, 241],
  line: [209, 217, 224],
  text: [31, 35, 40],
  muted: [89, 99, 110],
  faint: [129, 139, 152],
  blue: [9, 105, 218],
  green: [26, 127, 55],
  orange: [188, 76, 0],
  red: [209, 36, 47],
  purple: [130, 80, 223],
  teal: [27, 124, 131],
  yellow: [154, 103, 0],
  pink: [191, 57, 137],
  selected: [221, 244, 255],
  key: [239, 242, 245],
  hero: [
    [130, 80, 223],
    [9, 105, 218],
    [27, 124, 131],
    [26, 127, 55],
  ],
  heroText: [255, 255, 255],
  cat: [255, 214, 130],
}

export const THEMES = { dark: DARK, light: LIGHT } as const satisfies Record<string, Palette>
type ThemeName = keyof typeof THEMES
export const AUTO_THEME = 'auto'

const themeOf = (name: string | undefined): ThemeName | undefined =>
  Object.keys(THEMES).find(t => (name ?? '').toLowerCase().includes(t)) as ThemeName | undefined

const systemTheme = (systemDark: boolean | undefined): ThemeName | undefined => (systemDark === undefined ? undefined : systemDark ? 'dark' : 'light')

export const resolvePalette = (setting: string | undefined, claudeTheme: string | undefined, systemDark: boolean | undefined): Palette => {
  const chosen = setting && setting !== AUTO_THEME ? themeOf(setting) : undefined
  const claude = themeOf(claudeTheme) ?? systemTheme(systemDark) ?? 'dark'
  const palette = THEMES[chosen ?? claude]
  return { ...palette, code: THEMES[claude].code }
}

export const hex = ([r, g, b]: Rgb): string => `#${[r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`

export const mix = (a: Rgb, b: Rgb, amount: number): Rgb => [
  a[0] + (b[0] - a[0]) * amount,
  a[1] + (b[1] - a[1]) * amount,
  a[2] + (b[2] - a[2]) * amount,
]

export const tint = (p: Palette, color: Rgb, amount = 0.25): string => hex(mix(p.base, color, amount))

const gradient = (stops: readonly Rgb[], at: number): Rgb => {
  if (stops.length === 1) {
    return stops[0] as Rgb
  }
  const scaled = Math.max(0, Math.min(1, at)) * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(scaled))
  return mix(stops[i] as Rgb, stops[i + 1] as Rgb, scaled - i)
}

const DEFAULT_COLOR = 0x01000000
const packed = ([r, g, b]: Rgb) => (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b)

type Cell = { ch: string; fg?: Rgb; bg?: Rgb }

export class Canvas {
  readonly cells: Cell[]

  constructor(
    readonly columns: number,
    readonly rows: number,
  ) {
    this.cells = Array.from({ length: columns * rows }, () => ({ ch: ' ' }))
  }

  set(x: number, y: number, cell: Cell) {
    if (x >= 0 && x < this.columns && y >= 0 && y < this.rows) {
      this.cells[y * this.columns + x] = { ...this.cells[y * this.columns + x], ...cell }
    }
  }

  write(x: number, y: number, text: string, fg: Rgb) {
    ;[...text].forEach((ch, i) => this.set(x + i, y, { ch, fg }))
  }

  encode(): string {
    const words = new Uint32Array(this.cells.length * 3)
    this.cells.forEach((c, i) => {
      words[i * 3] = c.ch.codePointAt(0) ?? 32
      words[i * 3 + 1] = c.fg ? packed(c.fg) : DEFAULT_COLOR
      words[i * 3 + 2] = c.bg ? packed(c.bg) : DEFAULT_COLOR
    })
    return base64(new Uint8Array(words.buffer))
  }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const base64 = (bytes: Uint8Array): string => {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    out += B64[a >> 2]
    out += B64[((a & 3) << 4) | (b >> 4)]
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : '='
    out += i + 2 < bytes.length ? B64[c & 63] : '='
  }
  return out
}

export const CAT = 'ᓚᘏᗢ'
const GROUND = '⠂'
const TITLE = ' ◆ side insights '
const SPARKS = ['⋅', '✧', '✦', '✧']
const SNORE = ['z', 'zZ', 'zZz', 'zZ']
const SPARK_SPOTS = [0.12, 0.31, 0.47, 0.66, 0.83]
const ROWS = 3
const WAVE_FRAMES = 60
const WAVE_DEPTH = 0.08
const SPARK_STAGGER = 3
const SPARK_EVERY_BUSY = 8
const SPARK_EVERY_IDLE = 24
const SNORE_FRAMES = 4
const TRAIL = 3

export const hero = (p: Palette, columns: number, busy: boolean, tick: number): Canvas => {
  const canvas = new Canvas(columns, ROWS)
  const shift = busy ? (tick % WAVE_FRAMES) / WAVE_FRAMES : 0
  for (let x = 0; x < columns; x++) {
    const at = columns > 1 ? x / (columns - 1) : 0
    const wave = busy ? WAVE_DEPTH * Math.sin((at + shift) * Math.PI * 2) : 0
    const color = gradient(p.hero, at + wave)
    canvas.set(x, 0, { ch: '▄', fg: color })
    canvas.set(x, 1, { ch: ' ', bg: color })
    canvas.set(x, 2, { ch: '▀', fg: color })
  }
  SPARK_SPOTS.forEach((spot, i) => {
    const x = Math.floor(spot * columns)
    const phase = (tick + i * SPARK_STAGGER) % (busy ? SPARK_EVERY_BUSY : SPARK_EVERY_IDLE)
    const ch = SPARKS[phase % SPARKS.length] ?? '⋅'
    if (phase < SPARKS.length) {
      canvas.set(x, 1, { ch, fg: mix(gradient(p.hero, spot), p.heroText, 0.7) })
    }
  })
  canvas.write(1, 1, TITLE, p.heroText)
  const trackStart = TITLE.length + 3
  const track = Math.max(0, columns - trackStart - 2)
  if (track >= CAT.length + 4) {
    for (let x = 0; x < track; x++) {
      canvas.set(trackStart + x, 1, { ch: GROUND, fg: mix(gradient(p.hero, (trackStart + x) / columns), p.heroText, 0.45) })
    }
    if (busy) {
      const room = track - CAT.length
      const spot = tick % (room + 1)
      for (let d = 1; d <= TRAIL && spot - d >= 0; d++) {
        canvas.set(trackStart + spot - d, 1, { ch: d === 1 ? '∘' : '⋅', fg: mix(gradient(p.hero, (trackStart + spot) / columns), p.heroText, 0.9 - d * 0.2) })
      }
      canvas.write(trackStart + spot, 1, CAT, p.cat)
    } else {
      const spot = track - CAT.length - 4
      canvas.write(trackStart + spot, 1, CAT, p.cat)
      const snore = SNORE[Math.floor(tick / SNORE_FRAMES) % SNORE.length] ?? 'z'
      canvas.write(trackStart + spot + CAT.length + 1, 1, snore.padEnd(3, ' '), p.heroText)
    }
  }
  return canvas
}

export type Segment = { value: number; color: Rgb }

export const meter = (p: Palette, columns: number, segments: Segment[], total: number, gap = false): Canvas => {
  const canvas = new Canvas(columns, 1)
  const empty = mix(p.base, p.line, 0.9)
  for (let x = 0; x < columns; x++) {
    canvas.set(x, 0, { ch: '▆', fg: empty })
  }
  let start = 0
  let acc = 0
  for (const seg of segments) {
    acc += seg.value
    const end = total ? Math.round((columns * acc) / total) : 0
    for (let x = start; x < end; x++) {
      const edge = gap && x === end - 1 && end < columns
      canvas.set(x, 0, edge ? { ch: ' ' } : { ch: '▆', fg: seg.color })
    }
    start = end
  }
  return canvas
}
