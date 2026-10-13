const JAMO_KEYS: Record<string, string> = {
  ㅂ: 'q', ㅈ: 'w', ㄷ: 'e', ㄱ: 'r', ㅅ: 't', ㅛ: 'y', ㅕ: 'u', ㅑ: 'i', ㅐ: 'o', ㅔ: 'p',
  ㅁ: 'a', ㄴ: 's', ㅇ: 'd', ㄹ: 'f', ㅎ: 'g', ㅗ: 'h', ㅓ: 'j', ㅏ: 'k', ㅣ: 'l',
  ㅋ: 'z', ㅌ: 'x', ㅊ: 'c', ㅍ: 'v', ㅠ: 'b', ㅜ: 'n', ㅡ: 'm',
  ㅃ: 'q', ㅉ: 'w', ㄸ: 'e', ㄲ: 'r', ㅆ: 't', ㅒ: 'o', ㅖ: 'p',
  ㅘ: 'hk', ㅙ: 'ho', ㅚ: 'hl', ㅝ: 'nj', ㅞ: 'np', ㅟ: 'nl', ㅢ: 'ml',
  ㄳ: 'rt', ㄵ: 'sw', ㄶ: 'sg', ㄺ: 'fr', ㄻ: 'fa', ㄼ: 'fq', ㄽ: 'ft', ㄾ: 'fx', ㄿ: 'fv', ㅀ: 'fg', ㅄ: 'qt',
}

const CHOSEONG = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'
const JUNGSEONG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ'
const JONGSEONG = ['', ...'ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ']
const SYLLABLE_FIRST = 0xac00
const SYLLABLE_LAST = 0xd7a3
const PER_CHOSEONG = 588
const PER_JUNGSEONG = 28
const LATIN_KEY = /^[0-9a-z]$/

const jamoOf = (ch: string): string[] => {
  const code = ch.codePointAt(0) ?? 0
  if (code < SYLLABLE_FIRST || code > SYLLABLE_LAST) {
    return [ch]
  }
  const index = code - SYLLABLE_FIRST
  const jong = JONGSEONG[index % PER_JUNGSEONG] ?? ''
  return [CHOSEONG[Math.floor(index / PER_CHOSEONG)] ?? '', JUNGSEONG[Math.floor((index % PER_CHOSEONG) / PER_JUNGSEONG)] ?? '', ...(jong ? [jong] : [])]
}

export const keysFromText = (text: string): string[] =>
  [...text].flatMap(jamoOf).flatMap(part => {
    const lower = part.toLowerCase()
    if (LATIN_KEY.test(lower)) {
      return [lower]
    }
    return [...(JAMO_KEYS[part] ?? '')]
  })
