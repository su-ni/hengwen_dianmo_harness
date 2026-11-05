/* ============================================================
   halo/memoryfield.ts —— 记忆场（第二副面孔）

   **换过三次实现，前两次都错**，记在这里免得再走回去：

   ① 星图（撒点 + 连线）：那是另一套视觉语言（圆点/星云），
      跟光环的「刻度/数据块/扫描线」不是一家人，拼一起像两个软件。
   ② 泳道 + 横向时间轴：每条泳道只有 1–3 条记忆，均分整宽后
      每块只剩 30px —— 那是一根针，不是一个块。试了五轮参数都不成立。

   **根因**：「横向按时间排」要求同一条泳道里有很多条记忆才铺得开。
   现在只有 10 条，任何横向排布都会空。

   ③ 现在的做法：**一条记忆占满一横排**。时间由「排的位置」表达，
      不由「块的长度」表达。10 条就是 10 条实打实的横条，
      每条都放得下正文 —— 这才是「让人看得懂」的标准。

   怎么读：
     · 从上到下 = 从新到旧（最新那条在最上面）
     · 每条左边是类型色条 + 类型名，中间是正文，右边是时间
     · 扫描线从上往下走，走到哪条就点亮哪条 —— 同光环的节拍扫描
   ============================================================ */

import type { Tokens } from './tokens'

type Ctx = CanvasRenderingContext2D
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
const FONT = 'ui-monospace, "Cascadia Mono", Consolas, monospace'

export type MemCell = {
  id: string
  kind: string
  content: string
  weight: number
  created: string
  row: number
  glow: number
  lane: number
  t: number
  span: number
  /** Letta 三层：core 每轮都进系统提示，recall 近期活跃，archival 只靠检索 */
  layer: string
}

export const LANE_ORDER = ['pref', 'fact', 'difficulty', 'goal', 'change', 'insight']
export const LANE_CN: Record<string, string> = {
  pref: '偏好', fact: '事实', difficulty: '困难点', goal: '目标', change: '变更', insight: '洞察',
}

function kindColor(o: { pal: Tokens }, kind: string): Tokens['white'] {
  switch (kind) {
    case 'pref': return o.pal.warm
    case 'difficulty': return o.pal.danger
    case 'goal': return o.pal.gold
    case 'change': return o.pal.lilac
    case 'insight': return o.pal.white
    default: return o.pal.cool
  }
}

/* ---------------- 布局：一条一行，新在上 ---------------- */
export function layoutField(
  mems: { id: string; kind: string; content: string; weight?: number; created_at?: string }[],
): MemCell[] {
  const sorted = [...mems].sort((a, b) =>
    String(b.created_at || '').localeCompare(String(a.created_at || '')))
  const LANE: Record<string, number> = { pref: 0, fact: 1, difficulty: 2, goal: 3, change: 4, insight: 5 }
  return sorted.map((m, i) => ({
    id: m.id,
    kind: m.kind,
    content: m.content,
    weight: clamp((m.weight ?? 0.6) / 1.2, 0.15, 1),
    created: String(m.created_at || ''),
    row: i,
    glow: 0,
    layer: (m as any).layer || 'recall',
    lane: LANE[m.kind] ?? 1,
    t: 0,
    span: 1,
  }))
}

/* t 要给抬头让位：记忆场抬头（"N 条记忆" + 层分布条）浮在左上角，
     它大约占 56px 高。绘制区从它下面开始，两行字才不会叠在一起。 */
const PAD = { l: 14, r: 18, t: 62, b: 10 }
const ROW_MAX = 56
const ROW_MIN = 30

function rowHeight(h: number, n: number) {
  const avail = h - PAD.t - PAD.b
  return clamp(avail / Math.max(1, n), ROW_MIN, ROW_MAX)
}

export type FieldOpts = {
  pal: Tokens
  T: number
  scan: number
  hot?: string | null
}

export function drawField(x: Ctx, w: number, h: number, cells: MemCell[], o: FieldOpts) {
  x.clearRect(0, 0, w, h)
  if (!cells.length) {
    x.font = '600 11px ' + FONT
    x.fillStyle = o.pal.rgba(o.pal.white, 0.3)
    x.textAlign = 'center'
    x.fillText('还没有记忆 —— 它还没被记住什么', w / 2, h / 2)
    x.textAlign = 'left'
    return
  }

  const rh = rowHeight(h, cells.length)
  const total = rh * cells.length
  const top0 = PAD.t + Math.max(0, (h - PAD.t - PAD.b - total) / 2)
  const scanY = PAD.t + (h - PAD.t - PAD.b) * clamp(o.scan, 0, 1)
  const innerW = w - PAD.l - PAD.r
  const TYPE_W = 62
  const TIME_W = 74

  cells.forEach((c, i) => {
    const y = top0 + i * rh
    const col = kindColor(o, c.kind)
    const hot = o.hot === c.id
    const near = Math.max(0, 1 - Math.abs(y + rh / 2 - scanY) / (rh * 2.4))
    const lit = clamp(0.42 + c.weight * 0.4 + near * 0.55 + (hot ? 0.85 : 0), 0, 1)

    x.fillStyle = o.pal.rgba(o.pal.white, i % 2 === 0 ? 0.02 : 0.008)
    x.fillRect(PAD.l, y + 1, innerW, rh - 2)

    x.fillStyle = o.pal.rgba(col, lit * 0.95)
    x.fillRect(PAD.l, y + 5, 3, rh - 10)

    /* ---- Letta 层标记 ----
       常驻（core）：左边再叠一条**实心竖杠**，长度撑满整行 ——
       它代表「这条每轮都在模型的系统提示里」，是最该被看见的差别。
       近期（recall）：一条短一点的，表示「这一阵子在用」。
       归档（archival）：不画（它不常驻，画了反而喧宾夺主）。 */
    if (c.layer === 'core') {
      x.fillStyle = o.pal.rgba(o.pal.white, 0.85)
      x.fillRect(PAD.l - 4, y + 5, 2, rh - 10)
    } else if (c.layer === 'recall') {
      x.fillStyle = o.pal.rgba(o.pal.white, 0.22)
      x.fillRect(PAD.l - 4, y + rh * 0.35, 2, rh * 0.3)
    }

    x.font = '700 10px ' + FONT
    x.textBaseline = 'middle'
    x.fillStyle = o.pal.rgba(col, lit * 0.9)
    x.fillText(LANE_CN[c.kind] || c.kind, PAD.l + 12, y + rh / 2)

    const textX = PAD.l + TYPE_W
    const timeX = PAD.l + innerW - TIME_W
    x.font = '500 12px ' + FONT
    x.fillStyle = o.pal.rgba(o.pal.white, clamp(0.52 + lit * 0.48, 0, 1))
    let text = c.content || '（空）'
    const maxW = timeX - textX - 14
    if (x.measureText(text).width > maxW) {
      while (text.length > 4 && x.measureText(text + '…').width > maxW) text = text.slice(0, -1)
      text += '…'
    }
    x.fillText(text, textX, y + rh / 2)

    x.font = '500 9px ' + FONT
    x.textAlign = 'right'
    x.fillStyle = o.pal.rgba(o.pal.white, 0.28)
    x.fillText(shortTime(c.created), PAD.l + innerW - 8, y + rh / 2)

    /* 常驻的那几条，在时间左边写一个「常驻」——
       一个词就够，但它是这一版最要紧的信息：
       「哪些事它每轮都记得」和「哪些只是存着」是两回事。 */
    if (c.layer === 'core') {
      x.fillStyle = o.pal.rgba(o.pal.white, 0.55)
      x.fillText('常驻', PAD.l + innerW - TIME_W - 10, y + rh / 2)
    }
    x.textAlign = 'left'

    /* 权重：类型名右边一小段刻度 */
    x.fillStyle = o.pal.rgba(col, 0.5)
    x.fillRect(PAD.l + 12, y + rh - 6, Math.max(4, 44 * c.weight), 2)

    if (near > 0.25) {
      x.strokeStyle = o.pal.rgba(col, near * 0.5)
      x.lineWidth = 1
      x.strokeRect(PAD.l + 0.5, y + 1.5, innerW - 1, rh - 3)
    }

    if (hot) {
      x.fillStyle = o.pal.rgba(col, 0.07)
      x.fillRect(PAD.l, y + 1, innerW, rh - 2)
      x.strokeStyle = o.pal.rgba(o.pal.white, 0.9)
      x.lineWidth = 1
      x.strokeRect(PAD.l + 0.5, y + 1.5, innerW - 1, rh - 3)
    }
  })

  const sg = x.createLinearGradient(0, scanY - 44, 0, scanY + 4)
  sg.addColorStop(0, o.pal.rgba(o.pal.white, 0))
  sg.addColorStop(0.85, o.pal.rgba(o.pal.white, 0.035))
  sg.addColorStop(1, o.pal.rgba(o.pal.white, 0.10))
  x.fillStyle = sg
  x.fillRect(PAD.l, scanY - 44, innerW, 50)
  x.fillStyle = o.pal.rgba(o.pal.white, 0.30)
  x.fillRect(PAD.l, scanY, innerW, 1)
}

function shortTime(s: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/.exec(s || '')
  return m ? m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5] : (s || '').slice(0, 12)
}

export function hitCell(
  mx: number, my: number, w: number, h: number, cells: MemCell[],
): MemCell | null {
  if (!cells.length) return null
  const rh = rowHeight(h, cells.length)
  const total = rh * cells.length
  const top0 = PAD.t + Math.max(0, (h - PAD.t - PAD.b - total) / 2)
  if (mx < PAD.l || mx > w - PAD.r) return null
  const i = Math.floor((my - top0) / rh)
  if (i < 0 || i >= cells.length) return null
  return cells[i]
}
