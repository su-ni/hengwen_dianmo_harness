/* ============================================================
   halo/panels.ts —— 底部那排面板（官方 lab.html 的 .panels）

   官方有 8 块，铺成一行：
     INVESTIGATION FEED / ADVECTION SOLVER / METHOD WORKSPACE / DIFF FIELD
     SOURCE ROUTES / VALIDATION / 12 AGENTS / REFERENCE INDEX

   它们在这套设计里不是装饰，是「舞台之外的另一半信息」：
   舞台告诉你在动着，面板告诉你**动着的是什么**。

   我们逐块换成本业的东西，块数、排布、密度照旧：
     ┌ 1 调查流水     ← 工具的调用流水（真实的）
     ├ 2 对流场       ← 保留（微观粒子，是这台机器的「呼吸」）
     ├ 3 方法工作区   ← 正在打字的代码，换成「它在拼什么」的脚本
     ├ 4 差分场       ← 参考 vs 实现，换成「计划 vs 今天」
     ├ 5 来源路线     ← 每本资料 → 入库 → 可查 的三段进度
     ├ 6 校验样本     ← 保留（柱状分布，是「量」的感觉）
     ├ 7 子智能体     ← 12 个 agent 的派发格
     └ 8 方法索引     ← 28 列 × 11 行 的匹配矩阵，换成「知识点 × 掌握度」
   ============================================================ */

import type { Bubble, MemRow, ToolCall } from './feed'
import type { Tokens } from './tokens'

type Ctx = CanvasRenderingContext2D
const rnd = Math.random
const rr = (a: number, b: number) => a + rnd() * (b - a)
const pick = <T,>(a: T[]): T => a[(rnd() * a.length) | 0]
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))

const FONT = 'ui-monospace, "Cascadia Mono", Consolas, monospace'

/* ---------- 画布型面板的公共部分 ---------- */
export type PanelCtx = {
  pal: Tokens
  T: number
  dt: number
}

/** 按容器尺寸重设 canvas，返回 2d ctx 与 CSS 宽高 */
export function fitCanvas(cv: HTMLCanvasElement): { x: Ctx; w: number; h: number } {
  const r = cv.getBoundingClientRect()
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height))
  if (cv.width !== w * dpr || cv.height !== h * dpr) {
    cv.width = w * dpr; cv.height = h * dpr
  }
  const x = cv.getContext('2d') as Ctx
  x.setTransform(dpr, 0, 0, dpr, 0, 0)
  return { x, w, h }
}

/* ============================================================
   2 · 对流场（官方 ADVECTION / PARTICLE SOLVER）
   320 个粒子跟着一个正弦叠加的流场走，留短轨迹。
   这是舞台上那台机器的「微观视角」—— 整体在按节拍推进，粒子在打旋。
   ============================================================ */
let advP: { x: number; y: number; l: number }[] = []
export function drawAdv(cv: HTMLCanvasElement, pc: PanelCtx) {
  const { x, w, h } = fitCanvas(cv)
  const { pal, T } = pc
  x.fillStyle = 'rgba(0,0,0,0.22)'
  x.fillRect(0, 0, w, h)
  x.fillStyle = pal.rgba(pal.lilac, 0.18)
  for (let i = 6; i < w; i += 12) for (let j = 6; j < h; j += 12) x.fillRect(i, j, 1, 1)

  if (advP.length === 0 || advP[0].x > w * 2) {
    advP = Array.from({ length: 300 }, () => ({ x: rnd() * w, y: rnd() * h, l: rnd() * 3 }))
  }
  const flow = (px: number, py: number) =>
    Math.sin(px * 0.035 + T * 0.6) * Math.cos(py * 0.05 - T * 0.4) * Math.PI +
    Math.sin((px + py) * 0.01 + T * 0.2)

  x.strokeStyle = pal.rgba(pal.white, 0.62)
  x.lineWidth = 0.8
  x.beginPath()
  for (const p of advP) {
    const a = flow(p.x, p.y)
    const nx = p.x + Math.cos(a) * 22 * pc.dt, ny = p.y + Math.sin(a) * 22 * pc.dt
    x.moveTo(p.x, p.y)
    x.lineTo(nx + Math.cos(a) * 2, ny + Math.sin(a) * 2)
    p.x = nx; p.y = ny; p.l -= pc.dt
    if (p.l < 0 || p.x < 0 || p.x > w || p.y < 0 || p.y > h) {
      p.x = rnd() * w; p.y = rnd() * h; p.l = rr(1, 4)
    }
  }
  x.stroke()
}

/* ============================================================
   4 · 差分场（官方 SHARED SCENE / DIFFERENCE FIELD）
   左右两张网格：左边「参考」，右边「实现」，右下角高亮差得最多的地方。
   我们这里：左 = 计划，右 = 今天实际做的。差异处就是「没跟上」。
   ============================================================ */
export function drawDiff(cv: HTMLCanvasElement, pc: PanelCtx) {
  const { x, w, h } = fitCanvas(cv)
  const { pal, T } = pc
  x.clearRect(0, 0, w, h)
  const gap = 8, mw = (w - gap) / 2, mh = h * 0.68
  const cols = 22, rows = 13, cw = mw / cols, ch = (mh - 10) / rows
  const hist = new Array(28).fill(0) as number[]

  for (let m = 0; m < 2; m++) {
    const ox = m * (mw + gap)
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        let v = 0.5 + 0.25 * Math.sin(i * 0.45 + T * 0.8) * Math.cos(j * 0.5 - T * 0.5) +
          0.2 * Math.sin((i + j) * 0.3 + T)
        let err = 0
        if (m) {
          const dx = i - 15 - Math.sin(T * 0.7) * 3, dy = j - 6
          err = Math.exp(-(dx * dx + dy * dy) / 6) * (0.5 + 0.5 * Math.sin(T * 2))
          v += err * 0.3
          hist[Math.min(27, (err * 27) | 0)]++
        }
        const g = clamp(v * 210 + 20, 0, 255) | 0
        x.fillStyle = err > 0.35 ? pal.rgba(pal.danger, 0.5 + err * 0.5) : 'rgb(' + g + ',' + g + ',' + g + ')'
        x.fillRect(ox + i * cw, 10 + j * ch, cw - 0.6, ch - 0.6)
      }
    }
  }
  const by = mh + 4, bh = h - by, bw = w / hist.length
  const mx = Math.max(...hist.slice(1), 1)
  hist.forEach((v, i) => {
    const hh = i === 0 ? bh * 0.9 : (v / mx) * bh * 0.8 + 1
    x.fillStyle = i > 9 ? pal.rgba(pal.warm, 0.9) : pal.rgba(pal.white, 0.45)
    x.fillRect(i * bw, by + bh - hh, bw - 1, hh)
  })
}

/* ============================================================
   6 · 校验样本（官方 VALIDATION / SAMPLE BUFFER）
   三条不断累积的柱，偶尔窜一下 —— 这是「量」的感觉，肉眼可见在攒。
   ============================================================ */
let valBuf: number[][] = [[], [], []]
let valSpike = 0
export function drawVal(cv: HTMLCanvasElement, pc: PanelCtx) {
  const { x, w, h } = fitCanvas(cv)
  const { pal, T } = pc
  x.clearRect(0, 0, w, h)
  const N = 90
  if (valBuf[0].length === 0) valBuf = [[], [], []].map(() => Array.from({ length: N }, () => rnd()))
  valSpike = Math.max(0, valSpike - pc.dt * 2)
  if (rnd() < pc.dt * 0.9) valSpike = rr(0.4, 1)
  for (let k = 0; k < 3; k++) {
    const arr = valBuf[k]
    if (T * (30 + k * 12) > arr.length) {
      arr.shift()
      arr.push(clamp(0.5 + 0.3 * Math.sin(T * (1 + k) + k) + (k === 0 ? valSpike * 0.4 : 0) + rr(-0.1, 0.1), 0.03, 1))
    }
    x.strokeStyle = pal.rgba(k === 0 ? pal.warm : k === 1 ? pal.cool : pal.lilac, 0.75 - k * 0.14)
    x.lineWidth = 0.8
    x.beginPath()
    for (let i = 0; i < arr.length; i++) {
      const px = (i / (arr.length - 1)) * w
      const py = h - 2 - arr[i] * (h - 6)
      if (i === 0) x.moveTo(px, py); else x.lineTo(px, py)
    }
    x.stroke()
  }
}

/* ============================================================
   8 · 匹配矩阵（官方 METHOD / REFERENCE INDEX）
   11 行 × 28 列的格子，亮的是「命中」。我们换成「知识点 × 掌握度」。
   ============================================================ */
const IDX_ROWS = 11, IDX_COLS = 28
let IDX: number[][] = []
export function drawIdx(cv: HTMLCanvasElement, pc: PanelCtx) {
  const { x, w, h } = fitCanvas(cv)
  const { pal, T } = pc
  x.clearRect(0, 0, w, h)
  if (IDX.length === 0) IDX = Array.from({ length: IDX_ROWS }, () => Array.from({ length: IDX_COLS }, () => rnd()))
  x.font = '600 6.5px ' + FONT
  x.textBaseline = 'middle'
  const lx = 22, rx = 26
  const cw = (w - lx - rx) / IDX_COLS, ch = h / IDX_ROWS
  const scan = Math.floor((T * 6) % IDX_COLS)
  if (rnd() < 0.3) {
    const r = (rnd() * IDX_ROWS) | 0, c = (rnd() * IDX_COLS) | 0
    IDX[r][c] = rnd()
  }
  for (let j = 0; j < IDX_ROWS; j++) {
    x.fillStyle = pal.rgba(pal.white, 0.35)
    x.fillText('K' + String(j + 1).padStart(2, '0'), 0, j * ch + ch / 2)
    let match = 0
    for (let i = 0; i < IDX_COLS; i++) {
      const v = IDX[j][i]
      x.fillStyle = v > 0.86 ? pal.rgba(pal.warm, 0.95)
        : v > 0.7 ? pal.rgba(pal.warm, 0.45)
          : v > 0.4 ? pal.rgba(pal.white, 0.28)
            : pal.rgba(pal.white, 0.10)
      if (i === scan) x.fillStyle = v > 0.4 ? pal.rgba(pal.white, 1) : pal.rgba(pal.white, 0.22)
      x.fillRect(lx + i * cw, j * ch + 1, cw - 1, ch - 2)
      if (v > 0.7) match++
    }
    x.fillStyle = match > 7 ? pal.rgba(pal.warm, 0.95) : pal.rgba(pal.white, 0.3)
    x.fillText(match > 7 ? '熟' : '过', w - rx + 3, j * ch + ch / 2)
  }
}

/* ============================================================
   1 · 调查流水（DOM 面板，不用 canvas）—— 真实工具调用
   ============================================================ */
export function feedRows(calls: ToolCall[]): { n: string; vb: string; text: string }[] {
  const VERB: Record<string, string> = {}
  const verbOf = (name: string) => {
    if (VERB[name]) return VERB[name]
    const v = /^(web_|bili_|search|kb_|rag_|doc_|list_|get_|find)/.test(name) ? 'read'
      : /^(grade_|exam_|quiz_|make_|gen_)/.test(name) ? 'qa'
        : /^(note_|canvas_|plan_doc_|memory_|course_add|source_)/.test(name) ? 'build'
          : 'check'
    VERB[name] = v
    return v
  }
  /* 倒序（最新在最下），跟官方 feed「新的一行从底部冒出来」一致 */
  return [...calls].reverse().slice(-14).map((c, i) => ({
    n: String(i + 1).padStart(3, '0'),
    vb: verbOf(c.name),
    text: c.name + (c.ok ? '' : '（失败）'),
  }))
}

/* ============================================================
   3 · 方法工作区（官方 METHOD WORKSPACE，逐字打字的代码块）
   我们让它打的是「它在拼什么」—— 真实的工具名组合。
   ============================================================ */
export function codeLines(calls: ToolCall[]): { ln: string; fn: string; op: string }[] {
  const src = calls.slice(0, 9)
  const lines = src.map((c, i) => ({
    ln: String(i + 1).padStart(3, '0'),
    fn: c.name,
    op: '(' + (c.ms != null ? c.ms + 'ms' : '') + ')',
  }))
  while (lines.length < 9) {
    lines.push({ ln: String(lines.length + 1).padStart(3, '0'), fn: 'wait', op: '()' })
  }
  return lines
}

/* ============================================================
   5 · 来源路线（官方 SOURCE / EXTRACTION ROUTES）
   表格：资料来源 × [提取 / 入库 / 可查] 三格进度
   ============================================================ */
export type RouteRow = { name: string; st: number }
export function routeRows(mems: MemRow[]): RouteRow[] {
  const byKind = new Map<string, number>()
  for (const m of mems) byKind.set(m.kind, (byKind.get(m.kind) || 0) + 1)
  const names: [string, string][] = [
    ['goal', '目标'], ['fact', '事实'], ['difficulty', '困难点'], ['pref', '偏好'], ['change', '变更'],
  ]
  return names.map(([k, cn]) => ({
    name: cn,
    st: (byKind.get(k) || 0) > 0 ? Math.min(3, 1 + Math.floor((byKind.get(k) || 0) / 2)) : 0,
  }))
}

/* ============================================================
   7 · 子智能体派发（官方 12 AGENTS / DISPATCH）
   真实的在跑任务 + 记忆类型，铺成网格
   ============================================================ */
export type AgentCell = { id: string; role: string; done: number; st: string }
export function agentCells(bubbles: Bubble[], mems: MemRow[]): AgentCell[] {
  const out: AgentCell[] = []
  const roles = ['读', '写', '判', '管']
  const live = bubbles.filter((b) => b.state === 'running' || b.state === 'ask')
  const total = Math.max(4, Math.min(12, live.length + 4))
  for (let i = 0; i < total; i++) {
    const b = live[i % Math.max(1, live.length)]
    const alive = !!b && i < Math.max(1, live.length)
    out.push({
      id: String(i + 1).padStart(2, '0'),
      role: roles[i % 4],
      done: alive ? Math.min(6, (b?.tools || 0) % 7) : (mems.length > i ? 6 : 2),
      st: alive ? (b?.state === 'ask' ? '等你答' : '在跑') : '空闲',
    })
  }
  return out
}
