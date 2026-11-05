/* ============================================================
   halo/theme.ts —— 光环配色：官方 HALOFLUX 的每个色点都换成系统变量

   官方（web/halo/lab.html）是一套冷白 + 淡紫 + 灰青。这里不重画它的视觉，
   只换色：**56 个参数一个不动**，动的是「光是什么颜色」。

   一色一职（对齐 theme.css 的规矩）：
     琥珀 --act   = 现在 / 当下 / 正在跑      → 主光束、圆环游标、燃烧的记忆
     青   --en    = 已完成的稳定事实          → 事实类记忆、已点亮的光点
     蓝   --math  = 结构 / 关联 / 图谱        → 记忆之间的连线、星图边
     橙   --cs    = 困难点 / 需要盯的地方     → difficulty 类记忆
     金   --pol   = 目标 / 长期                → goal 类记忆
     珊瑚 --bad   = 变更 / 冲突                → change 类记忆
   背景一律 --bg(#000)，跟主界面同一个黑。

   为什么不是「把 #98e0cf 换成 var(--en)」了事：
   Canvas 里要的是 [r,g,b] 三个整数（要拼 rgba() 和渐变），
   直接读 CSS 变量会拿到 "var(--en)" 这种字符串。所以这里解析一次、
   缓存成三元组，主题改了重新解析 —— 不把颜色硬编码进引擎。
   ============================================================ */

export type RGB = [number, number, number]
export type MemKind = 'pref' | 'fact' | 'difficulty' | 'goal' | 'change' | 'insight'

/* 解析一次 CSS 变量 → [r,g,b]。取不到就用兜底值，绝不让引擎因为
   「变量还没挂上」而画出一片黑（那比颜色不对更难查）。 */
function cssVar(name: string, fallback: string): RGB {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    const hex = v || fallback
    const m = /^#([0-9a-f]{6})$/i.exec(hex)
    if (m) {
      const n = parseInt(m[1], 16)
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    }
    const m3 = /^#([0-9a-f]{3})$/i.exec(hex)
    if (m3) {
      const s = m3[1]
      return [parseInt(s[0] + s[0], 16), parseInt(s[1] + s[1], 16), parseInt(s[2] + s[2], 16)]
    }
    const m2 = /rgba?\(([^)]+)\)/.exec(hex)
    if (m2) {
      const p = m2[1].split(',').map((x) => parseFloat(x))
      return [p[0] | 0, p[1] | 0, p[2] | 0]
    }
  } catch { /* 无 DOM（构建期 / 单测）就走兜底 */ }
  return cssVarFromHex(fallback)
}

function cssVarFromHex(hex: string): RGB {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return [255, 255, 255]
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/* 官方那套色 → 系统这套色的映射表。
   左边是 lab.html 里出现过的每一种光色，右边是它在我们这里的身份。 */
export type Palette = {
  /* 基底 */
  bg: string           // 舞台底
  band: string         // 圆环黑带
  /* 光 */
  white: RGB           // 主光：官方 232,235,242 / 248,248,255
  warm: RGB            // 琥珀：正在发生的事情
  cool: RGB            // 青：稳定的事实
  lilac: RGB           // 蓝紫：结构与关联
  danger: RGB          // 珊瑚：变更/冲突
  gold: RGB            // 金：目标
  /* 记忆类型 → 光色 */
  kind: Record<MemKind, RGB>
  /* 梯度用的 rgba 串（引擎里直接拼 strokeStyle / fillStyle） */
  rgba: (c: RGB, a: number) => string
}

export function makePalette(): Palette {
  const B = (n: string, f: string) => cssVar(n, f)
  const white = B('--tx', '#FFFFFF')
  const warm = B('--act', '#FFB020')
  const cool = B('--en', '#4FC4C0')
  const lilac = B('--math', '#7FA8F0')
  const danger = B('--bad', '#FF6B4A')
  const gold = B('--pol', '#E0B84A')

  /* 主光不用纯白 —— 纯白在纯黑底上会「炸」，看久了累。
     取 --tx 往 --act 方向压一档：还是白，但带一点体温。 */
  const mix = (a: RGB, b: RGB, k: number): RGB => [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ]
  const main = mix(white, warm, 0.06)

  return {
    bg: '#000000',
    band: '#000000',
    white: main,
    warm, cool, lilac, danger, gold,
    kind: {
      pref: warm,        // 偏好 = 当下就生效的东西
      fact: cool,        // 事实 = 学到手、稳定了
      difficulty: danger, // 困难点 = 要盯的
      goal: gold,        // 目标 = 远处的锚
      change: mix(cool, danger, 0.5), // 计划变更 = 事实被改过
      insight: white,                 // 洞察 = 中性归纳，不判好坏
    },
    rgba: (c: RGB, a: number) => 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')',
  }
}

/* 记忆类型的中文名（图形、图例、tooltip 共用一份，别在多处各写一遍） */
export const KIND_CN: Record<MemKind, string> = {
  pref: '偏好',
  fact: '事实',
  difficulty: '困难点',
  goal: '目标',
  change: '变更',
  // insight 已正式收编（第六类）。它跟 difficulty 归一层：都在说"他哪里不行"。
  insight: '洞察',
}

export const KINDS: MemKind[] = ['pref', 'fact', 'difficulty', 'goal', 'change', 'insight']
