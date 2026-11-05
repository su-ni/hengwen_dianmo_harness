/* 调色板令牌：给非 React 的绘制模块用（panel / memoryfield / engine 共用）
   从 CSS 变量解析一次，缓存住；主题变了调 resetTokens() 重新解析。
   一行都不硬编码颜色 —— 换主题时这些画面自己跟着变。 */
export type RGB = [number, number, number]

export type Tokens = {
  white: RGB
  warm: RGB
  cool: RGB
  lilac: RGB
  danger: RGB
  gold: RGB
  bg: string
  rgba: (c: RGB, a: number) => string
}

let _cache: Tokens | null = null

function hex2rgb(hex: string): RGB {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) {
    const m3 = /^#([0-9a-f]{3})$/i.exec(hex.trim())
    if (m3) {
      const s = m3[1]
      return [parseInt(s[0] + s[0], 16), parseInt(s[1] + s[1], 16), parseInt(s[2] + s[2], 16)]
    }
    return [255, 255, 255]
  }
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function readVar(name: string, fallback: string): RGB {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    return hex2rgb(v || fallback)
  } catch { return hex2rgb(fallback) }
}

export function PALETTE_TOKENS(): Tokens {
  if (_cache) return _cache
  const t: Tokens = {
    white: readVar('--tx', '#FFFFFF'),
    warm: readVar('--act', '#FFB020'),
    cool: readVar('--en', '#4FC4C0'),
    lilac: readVar('--math', '#7FA8F0'),
    danger: readVar('--bad', '#FF6B4A'),
    gold: readVar('--pol', '#E0B84A'),
    bg: '#000000',
    rgba: (c: RGB, a: number) => 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')',
  }
  _cache = t
  return t
}

export function resetTokens() { _cache = null }

/* 稳定哈希：同一条记忆永远同一个相位，刷新不跳 */
export function hashS(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return ((h >>> 0) % 10000) / 10000
}

export function mix(a: RGB, b: RGB, k: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ]
}

export function clamp01(v: number) { return Math.max(0, Math.min(1, v)) }
